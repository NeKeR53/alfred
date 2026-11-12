/** Messages échangés entre un cadre isolé (page, panneau, fonctions) et la coquille. */

export const ALFRED_MESSAGE = "alfred/1";

export interface FrameRequest {
  alfred: typeof ALFRED_MESSAGE;
  kind: "request";
  id: string;
  method: string;
  params: unknown;
}

export interface FrameResponse {
  alfred: typeof ALFRED_MESSAGE;
  kind: "response";
  id: string;
  result?: unknown;
  error?: { message: string; detail?: unknown };
}

/** Événement poussé par la coquille (contexte, thème, appel de fonction) ou par le cadre (prêt, erreur). */
export interface FrameEvent {
  alfred: typeof ALFRED_MESSAGE;
  kind: "event";
  name: string;
  payload: unknown;
}

export type FrameMessage = FrameRequest | FrameResponse | FrameEvent;

export function isFrameMessage(value: unknown): value is FrameMessage {
  return typeof value === "object" && value !== null && (value as { alfred?: unknown }).alfred === ALFRED_MESSAGE;
}

/**
 * Raccourci clavier qu’un cadre remonte à la coquille (événement `shortcut`). Le cadre garde le focus clavier :
 * sans ce relais, les raccourcis globaux de la coquille (Cmd+K ou Ctrl+K pour la palette) ne répondent plus dès
 * qu’on a cliqué dans une page. Seules les combinaisons avec Cmd ou Ctrl remontent, jamais la frappe ordinaire.
 */
export interface FrameShortcut {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

type ShortcutSource = Pick<KeyboardEvent, keyof FrameShortcut | "repeat" | "isComposing">;

export function frameShortcut(event: ShortcutSource): FrameShortcut | undefined {
  if (!(event.metaKey || event.ctrlKey) || event.repeat || event.isComposing) return undefined;
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return undefined;
  const { key, code, metaKey, ctrlKey, altKey, shiftKey } = event;
  return { key, code, metaKey, ctrlKey, altKey, shiftKey };
}

/** Raccourcis que la coquille traite elle-même : le cadre empêche alors l’action par défaut du navigateur. */
export function isShellShortcut(shortcut: FrameShortcut): boolean {
  return shortcut.key.toLowerCase() === "k" && !shortcut.altKey && !shortcut.shiftKey;
}

/** Relit un raccourci reçu d’un cadre ; `undefined` si le message est mal formé. */
export function parseFrameShortcut(payload: unknown): FrameShortcut | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = payload as Record<string, unknown>;
  if (typeof value.key !== "string" || typeof value.code !== "string") return undefined;
  const flags = ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const;
  if (!flags.every((flag) => typeof value[flag] === "boolean")) return undefined;
  if (!(value.metaKey || value.ctrlKey)) return undefined;
  return {
    key: value.key,
    code: value.code,
    metaKey: value.metaKey as boolean,
    ctrlKey: value.ctrlKey as boolean,
    altKey: value.altKey as boolean,
    shiftKey: value.shiftKey as boolean,
  };
}
