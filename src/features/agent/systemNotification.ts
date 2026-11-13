/**
 * Notification du système quand un agent termine un tour ou attend une réponse alors que la fenêtre d’Alfred n’est
 * pas au premier plan. Rien en mode navigateur : seule la fenêtre de l’application a le module de notifications
 * (`tauri-plugin-notification`, permission `notification:default`).
 */

import { inTauri } from "../../lib/native";

/** La fenêtre est-elle au premier plan ? Une fenêtre réduite ou derrière une autre ne l’est pas. */
export function windowInFront(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

let permission: Promise<boolean> | undefined;

async function allowed(invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>) {
  permission ??= (async () => {
    const granted = await invoke<boolean | null>("plugin:notification|is_permission_granted");
    if (granted) return true;
    if (granted === false) return false;
    return (await invoke<string>("plugin:notification|request_permission")) === "granted";
  })().catch(() => false);
  return permission;
}

/** Montre une notification du système, sauf si la fenêtre est au premier plan ou hors de l’application. */
export async function notifySystem(title: string, body?: string): Promise<boolean> {
  if (!inTauri || windowInFront()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    if (!(await allowed(invoke))) return false;
    await invoke("plugin:notification|notify", { options: { title, ...(body ? { body: body.slice(0, 240) } : {}) } });
    return true;
  } catch {
    // Une notification refusée ou indisponible ne gêne pas la conversation.
    return false;
  }
}

/** Pour les tests : oublie la permission lue. */
export function resetSystemNotification() {
  permission = undefined;
}
