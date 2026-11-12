/**
 * Erreurs rapportées par les cadres affichés. L’agent les lit (outil `check`) pour corriger ses pages ; elles
 * viennent pourtant de la page elle-même, donc d’un code non fiable : seuls des champs typés et bornés passent.
 */

export interface FrameError {
  phase: "load" | "render" | "runtime";
  message: string;
  diagnostics?: Array<{ message: string; line?: number; column?: number }>;
  stack?: string;
}

/** Dernière erreur rapportée par chaque page affichée ; l’agent la lit pour se corriger. */
export const frameErrors = new Map<string, FrameError>();

const MAX_MESSAGE = 1_000;
const MAX_STACK = 4_000;
const MAX_DIAGNOSTICS = 20;

function text(value: unknown, limit: number): string {
  const raw = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

function position(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Relit l’erreur envoyée par un cadre : phase connue, textes tronqués, diagnostics limités. */
export function sanitizeFrameError(payload: unknown): FrameError {
  const value = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const phase = value.phase === "load" || value.phase === "render" ? value.phase : "runtime";
  const error: FrameError = { phase, message: text(value.message, MAX_MESSAGE) };
  if (Array.isArray(value.diagnostics)) {
    error.diagnostics = value.diagnostics.slice(0, MAX_DIAGNOSTICS).map((item) => {
      const diagnostic = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
      return {
        message: text(diagnostic.message, MAX_MESSAGE),
        line: position(diagnostic.line),
        column: position(diagnostic.column),
      };
    });
  }
  if (value.stack !== undefined) error.stack = text(value.stack, MAX_STACK);
  return error;
}
