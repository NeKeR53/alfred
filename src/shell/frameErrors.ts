/**
 * Erreurs rapportées par les cadres affichés, réduites à leur emplacement pour `check` (`runtimeErrors`). Le message
 * et la pile, écrits par la page, vont au journal de la page (`frameLogs`), que l’agent lit par `page_logs`. Les
 * erreurs de compilation, elles, sont calculées par Alfred et rendues par `check` (`pages[].errors`).
 */

export interface FrameError {
  phase: "load" | "render" | "runtime";
  /** Fichier du module où l’erreur est survenue, tel que le cadre l’a chargé (`modules/<module>/pages/<page>`). */
  file?: string;
  line?: number;
  column?: number;
  /** Toujours vrai : le message n’est pas dans `check`, il est dans le journal de la page (`page_logs`). */
  messageWithheld: true;
}

/** Dernière erreur rapportée par chaque page affichée ; l’agent la lit pour se corriger. */
export const frameErrors = new Map<string, FrameError>();

/** Adresse d’un fichier de module dans une pile d’appels : `/m/<module>/<clé>/<chemin>[?…]:<ligne>:<colonne>`. */
const FRAME =
  /\/m\/([a-z0-9-]+)\/[0-9a-f]{32}\/((?:pages|functions|lib)(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)?)+)(?:\?[^\s:)]*)?:(\d{1,7}):(\d{1,7})/g;

/** Relit l’erreur envoyée par le cadre du module `module` : la phase, et l’emplacement trouvé dans sa pile. */
export function sanitizeFrameError(payload: unknown, module: string): FrameError {
  const value = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const phase = value.phase === "load" || value.phase === "render" ? value.phase : "runtime";
  const error: FrameError = { phase, messageWithheld: true };
  const stack = typeof value.stack === "string" ? value.stack.slice(0, 20_000) : "";
  for (const match of stack.matchAll(FRAME)) {
    const [, owner, path, line, column] = match;
    if (owner !== module) continue;
    error.file = `modules/${owner}/${path}`;
    error.line = Number(line);
    error.column = Number(column);
    break;
  }
  return error;
}
