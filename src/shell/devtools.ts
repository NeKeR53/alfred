/**
 * Inspecteur web en développement : Cmd+Option+I (macOS) ou Ctrl+Maj+I ouvre l’inspecteur de la fenêtre, comme dans
 * un navigateur ; le clic droit « Inspecter l’élément » de WebKit reste aussi disponible dans un binaire de
 * développement. Rien de tout cela dans une version installée : le raccourci n’est posé qu’en développement
 * (`import.meta.env.DEV`), et la commande du cœur y répond par une erreur.
 */
import { inTauri } from "../lib/native";

/** Vrai pour Cmd+Option+I (macOS) ou Ctrl+Maj+I (Windows, Linux). */
export function isInspectShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "altKey" | "ctrlKey" | "shiftKey">,
): boolean {
  const letterI = event.code === "KeyI" || event.key.toLowerCase() === "i";
  if (!letterI) return false;
  return (event.metaKey && event.altKey && !event.ctrlKey) || (event.ctrlKey && event.shiftKey && !event.metaKey);
}

/** Pose le raccourci, en développement et dans Tauri seulement ; rend la fonction qui l’enlève. */
export function bindDevtoolsShortcut(target: Window = window, enabled = import.meta.env.DEV && inTauri): () => void {
  if (!enabled) return () => undefined;
  const onKey = (event: KeyboardEvent) => {
    if (!isInspectShortcut(event)) return;
    event.preventDefault();
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("alfred_open_devtools")).catch(() => undefined);
  };
  target.addEventListener("keydown", onKey, true);
  return () => target.removeEventListener("keydown", onKey, true);
}
