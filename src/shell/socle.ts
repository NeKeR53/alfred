import { useEffect, useState } from "react";
import { createNotifications, type Platform } from "socle-ui";
import { inTauri } from "../lib/native";

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

/**
 * Plein écran de la fenêtre, pour `SocleProvider` `isFullscreen` (D-370 de socle-ui) : sous macOS en plein écran,
 * l’AppShell ne réserve plus la place des boutons de fenêtre. Lu au démarrage, puis à chaque redimensionnement de la
 * fenêtre (entrer et sortir du plein écran la redimensionnent). Hors Tauri ou hors macOS : toujours faux.
 */
export function useWindowFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!inTauri || soclePlatform() !== "macos") return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const window = getCurrentWindow();
        const read = async () => {
          const value = await window.isFullscreen();
          if (active) setFullscreen(value);
        };
        const stop = await window.onResized(() => void read().catch(() => {}));
        if (active) unlisten = stop;
        else stop();
        await read();
      } catch {
        // Permission absente ou fenêtre fermée : la place des boutons de fenêtre reste réservée.
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  return fullscreen;
}
