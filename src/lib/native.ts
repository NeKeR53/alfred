/**
 * Accès au backend d’Alfred. Dans la fenêtre Tauri, les commandes passent par l’IPC ; dans un navigateur de test
 * (développement uniquement), elles passent par le pont HTTP du même backend, si bien que les deux exercent le
 * même code natif.
 */

export interface NativeError {
  message: string;
  detail?: unknown;
}

export class AlfredError extends Error {
  detail?: unknown;
  constructor(error: NativeError) {
    super(error.message);
    this.name = "AlfredError";
    this.detail = error.detail;
  }
}

const DEV_BRIDGE = "http://127.0.0.1:14731";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const inTauri = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

export function toError(error: unknown): AlfredError {
  if (error instanceof AlfredError) return error;
  if (error && typeof error === "object" && "message" in error) return new AlfredError(error as NativeError);
  return new AlfredError({ message: typeof error === "string" ? error : "Erreur inattendue." });
}

export async function invoke<Result = unknown>(command: string, args: Record<string, unknown> = {}): Promise<Result> {
  if (inTauri) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    try {
      return await tauriInvoke<Result>("alfred_invoke", { command, args });
    } catch (error) {
      throw toError(error);
    }
  }
  let response: Response;
  try {
    response = await fetch(`${DEV_BRIDGE}/__dev/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    });
  } catch {
    throw new AlfredError({ message: "Le backend d’Alfred ne répond pas. Lancer « pnpm tauri dev »." });
  }
  const body = (await response.json()) as { ok?: Result; error?: NativeError };
  if (body.error) throw new AlfredError(body.error);
  return body.ok as Result;
}

/**
 * Ouvre une page de l’espace (`module/page`, ou `module/page@instance`) seule dans sa propre fenêtre, ou ramène au
 * premier plan celle qui l’affiche déjà. Seulement dans l’application : un navigateur de test n’a qu’une fenêtre.
 */
export async function openPageWindow(reference: string): Promise<void> {
  if (!inTauri) throw new AlfredError({ message: "Les fenêtres de page ne s’ouvrent que dans l’application Alfred." });
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  try {
    await tauriInvoke("alfred_open_window", { reference });
  } catch (error) {
    throw toError(error);
  }
}

export interface NativeEvent {
  name: string;
  payload: unknown;
}

type Listener = (event: NativeEvent) => void;
const listeners = new Set<Listener>();
let started = false;

async function start() {
  if (started) return;
  started = true;
  const publish = (event: NativeEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  if (inTauri) {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<NativeEvent>("alfred:event", (event) => publish(event.payload));
    return;
  }
  const source = new EventSource(`${DEV_BRIDGE}/__dev/events`);
  source.onmessage = (message) => publish(JSON.parse(message.data) as NativeEvent);
}

/** S’abonne aux événements du backend ; renvoie la fonction de désabonnement. */
export function onNativeEvent(name: string, handler: (payload: unknown) => void): () => void {
  const listener: Listener = (event) => {
    if (event.name === name) handler(event.payload);
  };
  listeners.add(listener);
  void start();
  return () => {
    listeners.delete(listener);
  };
}

/** Adresse de base des cadres isolés (pages, panneaux, fonctions). */
export function frameBase(pageBase: string): string {
  return inTauri ? pageBase : `${DEV_BRIDGE}/__page`;
}

/** Ouvre une adresse web dans le navigateur du système. */
export async function openExternal(url: string): Promise<void> {
  if (inTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** Fait choisir un dossier à l’utilisateur ; `null` s’il annule. Hors de la fenêtre Tauri, aucun sélecteur natif. */
export async function pickFolder(title: string): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

/** Fait choisir un fichier à l’utilisateur ; `null` s’il annule. Hors de la fenêtre Tauri, aucun sélecteur natif. */
export async function pickFile(title: string): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: false, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

/**
 * Notification du système pour une notification d’Alfred : Rust ne l’envoie que si aucune fenêtre d’Alfred n’a le
 * focus (sinon la surimpression suffit). Dit si elle est partie ; hors de la fenêtre Tauri, jamais.
 */
export async function notifySystem(title: string, body?: string): Promise<boolean> {
  if (!inTauri) return false;
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  try {
    return await tauriInvoke<boolean>("alfred_notify_system", { title, body: body ?? null });
  } catch (error) {
    throw toError(error);
  }
}
