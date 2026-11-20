import { stripAnsi } from "./ansi";

/** Une ligne de journal : son texte (séquences ANSI comprises), ou ce texte avec son heure et son flux. */
export type LogLine =
  | string
  | {
      text: string;
      /** Heure de la ligne : date, nombre de millisecondes ou texte ISO 8601. */
      time?: Date | number | string;
      /** `stderr` marque la ligne d’une erreur, sans couleur seule (une marque dans la marge). */
      stream?: "stdout" | "stderr" | "stdin";
    };

/** Ce que `LogViewer` lit d’un canal : le résultat de `useChannel(id)` de `@alfred/sdk` convient tel quel. */
export interface LogChannel {
  events: readonly { seq: number; type?: string; data?: string; base64?: boolean; stream?: string }[];
  closed?: boolean;
  reason?: string | null;
  error?: Error | undefined;
}

export interface StoredLine {
  raw: string;
  time?: number;
  stderr?: boolean;
}

/** Heure ISO 8601 en tête de ligne, comme l’écrivent `docker logs --timestamps` et la plupart des services. */
const LEADING_TIME = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?) /;

function parseTime(value: Date | number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

/** Sépare l’heure placée en tête d’une ligne : elle passe dans la colonne de l’horodatage. */
function splitLeadingTime(raw: string): StoredLine {
  const found = LEADING_TIME.exec(raw);
  if (!found) return { raw };
  const time = parseTime(found[1].replace(",", ".").replace(" ", "T"));
  return time === undefined ? { raw } : { raw: raw.slice(found[0].length), time };
}

export function normalizeLine(line: LogLine): StoredLine {
  if (typeof line === "string") return splitLeadingTime(line);
  const stored = line.time === undefined ? splitLeadingTime(line.text) : { raw: line.text, time: parseTime(line.time) };
  return line.stream === "stderr" ? { ...stored, stderr: true } : stored;
}

/**
 * Lignes d’un journal et leur texte nettoyé, calculé à la première demande. Un journal alimenté par un canal grandit
 * par la fin et oublie ses lignes les plus anciennes au-delà de `max`.
 */
export class LineStore {
  lines: StoredLine[] = [];
  /** Lignes oubliées en tête : le numéro affiché d’une ligne est `dropped + index + 1`. */
  dropped = 0;
  private plain: (string | undefined)[] = [];
  private lastSeq = -1;
  private partial = false;
  private decoder: TextDecoder | undefined;

  constructor(private readonly max = Number.POSITIVE_INFINITY) {}

  text(index: number) {
    let value = this.plain[index];
    if (value === undefined) {
      value = stripAnsi(this.lines[index]?.raw ?? "");
      this.plain[index] = value;
    }
    return value;
  }

  /** Remplace tout (journal donné en tableau). */
  replace(lines: readonly LogLine[]) {
    this.lines = lines.map(normalizeLine);
    this.plain = [];
    this.dropped = 0;
  }

  private push(line: StoredLine) {
    if (this.partial) {
      // La dernière ligne d’un flux brut était incomplète : elle est complétée, pas dupliquée.
      const last = this.lines.length - 1;
      this.lines[last] = { ...line, raw: (this.lines[last]?.raw ?? "") + line.raw, time: this.lines[last]?.time };
      this.plain[last] = undefined;
      this.partial = false;
      return;
    }
    this.lines.push(line);
  }

  private trim() {
    const over = this.lines.length - this.max;
    if (over <= 0) return;
    this.lines.splice(0, over);
    this.plain.splice(0, over);
    this.dropped += over;
  }

  /**
   * Ajoute les événements d’un canal qui n’ont pas encore été lus (d’après leur rang). Un message texte peut porter
   * plusieurs lignes ; un morceau brut (base64) est décodé en UTF-8 et sa dernière ligne reste ouverte jusqu’au
   * morceau suivant. Rend vrai si des lignes ont été ajoutées.
   */
  append(channel: LogChannel, now = Date.now()) {
    if (channel.events.length === 0 && this.lastSeq >= 0) this.reset();
    let changed = false;
    for (const event of channel.events) {
      if (event.seq <= this.lastSeq) continue;
      this.lastSeq = event.seq;
      if ((event.type ?? "data") !== "data" || event.data === undefined) continue;
      let text = event.data;
      let open = false;
      if (event.base64) {
        this.decoder ??= new TextDecoder();
        const bytes = Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0));
        text = this.decoder.decode(bytes, { stream: true });
        open = !text.endsWith("\n");
        if (!open) text = text.slice(0, -1);
      }
      const parts = text.split("\n");
      parts.forEach((part, index) => {
        const stored = splitLeadingTime(part);
        this.push({
          ...stored,
          time: stored.time ?? now,
          ...(event.stream === "stderr" ? { stderr: true } : {}),
        });
        if (open && index === parts.length - 1) this.partial = true;
      });
      changed = true;
    }
    if (changed) this.trim();
    return changed;
  }

  reset() {
    this.lines = [];
    this.plain = [];
    this.dropped = 0;
    this.lastSeq = -1;
    this.partial = false;
    this.decoder = undefined;
  }
}

/** Indices des lignes qui contiennent `query`, sans tenir compte de la casse. */
export function findLines(store: LineStore, query: string): number[] {
  const needle = query.toLocaleLowerCase("fr-FR");
  if (!needle) return [];
  const found: number[] = [];
  for (let index = 0; index < store.lines.length; index += 1) {
    if (store.text(index).toLocaleLowerCase("fr-FR").includes(needle)) found.push(index);
  }
  return found;
}
