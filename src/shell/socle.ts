import { createNotifications, type Platform } from "socle-ui";

/**
 * Réglages de socle-ui pour Alfred : une seule file de notifications pour toute l’app (toasts et cloche de la barre
 * du haut), la plateforme du poste et le préfixe des choix mémorisés (sidebar, largeur du détail, dernière vue).
 */
export const notifications = createNotifications();

export const socleStorageKey = "alfred";

export function soclePlatform(): Platform {
  if (typeof navigator === "undefined") return "web";
  const agent = navigator.userAgent;
  if (/Mac/i.test(agent)) return "macos";
  if (/Windows/i.test(agent)) return "windows";
  return "web";
}
