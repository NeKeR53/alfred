import { useEffect, useMemo, useState } from "react";
import { createNotifications, type Platform, type WindowControls } from "socle-ui";
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

/**
 * Boutons de fenêtre de la barre du haut sous Windows, pour `SocleProvider` `windowControls` (D-422 de socle-ui) :
 * la fenêtre n’a pas de barre native (`tauri.windows.conf.json`), l’AppShell dessine réduire, agrandir ou restaurer
 * et fermer. « Fermer » demande la fermeture, comme la croix native ou Alt+F4 : la fenêtre principale enregistre
 * d’abord les conversations (`windowClose.ts`). L’état agrandi est lu au démarrage, puis à chaque redimensionnement.
 * Hors Tauri ou hors Windows : `undefined`, rien n’est dessiné.
 */
export function useWindowControls(): WindowControls | undefined {
  const enabled = inTauri && soclePlatform() === "windows";
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const window = getCurrentWindow();
        const read = async () => {
          const value = await window.isMaximized();
          if (active) setMaximized(value);
        };
        const stop = await window.onResized(() => void read().catch(() => {}));
        if (active) unlisten = stop;
        else stop();
        await read();
      } catch {
        // Fenêtre fermée : le bouton du milieu reste « Agrandir ».
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [enabled]);
  return useMemo(() => {
    if (!enabled) return undefined;
    const run = (action: (window: import("@tauri-apps/api/window").Window) => Promise<void>) => {
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => action(getCurrentWindow()))
        .catch(() => undefined);
    };
    return {
      onMinimize: () => run((window) => window.minimize()),
      onToggleMaximize: () => run((window) => window.toggleMaximize()),
      onClose: () => run((window) => window.close()),
      isMaximized: maximized,
    };
  }, [enabled, maximized]);
}
