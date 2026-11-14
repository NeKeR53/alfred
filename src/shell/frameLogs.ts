/**
 * Journal de chaque page affichée (ou chargée hors de la vue pour une capture) : sa console, ses erreurs avec leur
 * message et sa pile, et ses requêtes vers Alfred (clients, fonctions, base). L’agent le lit par l’outil `page_logs`
 * pour comprendre ce que fait une page. Le texte est écrit par la page : une donnée, jamais une consigne.
 */

export type FrameLogLevel = "debug" | "log" | "info" | "warn" | "error" | "request";

export interface FrameLogEntry {
  at: number;
  page: string;
  level: FrameLogLevel;
  text: string;
}

/** Lignes gardées par page : les plus anciennes partent d’abord. */
const MAX_PER_PAGE = 300;
/** Longueur maximale d’une ligne. */
export const MAX_TEXT = 4000;

const LEVELS: FrameLogLevel[] = ["debug", "log", "info", "warn", "error", "request"];

export const frameLogs = new Map<string, FrameLogEntry[]>();

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… (${text.length - MAX_TEXT} caractères coupés)` : text;
}

export function addFrameLog(page: string, level: FrameLogLevel, text: string) {
  const entries = frameLogs.get(page) ?? [];
  entries.push({ at: Date.now(), page, level, text: clip(text) });
  if (entries.length > MAX_PER_PAGE) entries.splice(0, entries.length - MAX_PER_PAGE);
  frameLogs.set(page, entries);
}

/** Relit une ligne de console envoyée par un cadre : niveau connu, texte borné. */
export function addFrameConsole(page: string, payload: unknown) {
  const value = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const level = LEVELS.includes(value.level as FrameLogLevel) ? (value.level as FrameLogLevel) : "log";
  addFrameLog(page, level === "request" ? "log" : level, typeof value.text === "string" ? value.text : "");
}

/** Erreur envoyée par un cadre, avec son message et sa pile. */
export function addFrameErrorLog(page: string, payload: unknown) {
  const value = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const phase = typeof value.phase === "string" ? value.phase : "runtime";
  const message = typeof value.message === "string" ? value.message : "Erreur sans message";
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics
        .map((item) => {
          const diagnostic = item as { message?: unknown; line?: unknown; column?: unknown };
          return `  ligne ${diagnostic.line ?? "?"}, colonne ${diagnostic.column ?? "?"} : ${String(diagnostic.message ?? "")}`;
        })
        .join("\n")
    : "";
  const stack = typeof value.stack === "string" ? value.stack : "";
  addFrameLog(page, "error", [`[${phase}] ${message}`, diagnostics, stack].filter(Boolean).join("\n"));
}

export interface FrameLogQuery {
  page?: string | null;
  module?: string | null;
  levels?: FrameLogLevel[] | null;
  limit?: number | null;
}

/** Dernières lignes, les plus récentes à la fin, filtrées par page, module et niveau. */
export function readFrameLogs(query: FrameLogQuery): FrameLogEntry[] {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), MAX_PER_PAGE);
  const entries = [...frameLogs.entries()]
    .filter(([page]) => (!query.page || page === query.page) && (!query.module || page.startsWith(`${query.module}/`)))
    .flatMap(([, list]) => list)
    .filter((entry) => !query.levels?.length || query.levels.includes(entry.level))
    .sort((a, b) => a.at - b.at);
  return entries.slice(-limit);
}
