/**
 * Fermeture de la fenêtre principale, reprise de OneApp : la croix enregistre d’abord les conversations, puis arrête
 * les CLI d’agents et ferme. Un enregistrement qui échoue ou ne répond pas ne retient pas la fenêtre en silence :
 * l’utilisateur choisit de fermer quand même ou de rester. Rien en mode navigateur.
 */
import { inTauri } from "../lib/native";

/** Fenêtre principale réduite à ce dont la fermeture a besoin. */
export interface ClosableWindow {
  onCloseRequested: (handler: (event: { preventDefault: () => void }) => void | Promise<void>) => Promise<() => void>;
  destroy: () => Promise<void>;
}

export interface MainWindowCloseSteps {
  /** Enregistrements à terminer avant de fermer : les conversations des agents. */
  save: () => Promise<void>;
  /** Arrête les CLI d’agents ; borné, il ne retient jamais la fermeture. */
  stopSessions: () => Promise<unknown>;
  /** Demande s’il faut fermer malgré un enregistrement impossible. */
  confirmUnsaved: (reason: string) => Promise<boolean>;
}

const SAVE_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 4_000;

function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Branche les étapes de fermeture sur une fenêtre ; renvoie de quoi les débrancher. */
export function registerMainWindowClose(window: ClosableWindow, steps: MainWindowCloseSteps) {
  let closing = false;
  return window.onCloseRequested(async (event) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      try {
        await within(steps.save(), SAVE_TIMEOUT_MS, "l’enregistrement ne répond pas.");
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        let close = true;
        try {
          close = await steps.confirmUnsaved(reason);
        } catch {
          // Sans boîte de dialogue, la fenêtre se ferme : la croix ne doit jamais rester sans effet.
        }
        if (!close) return;
      }
      await within(steps.stopSessions(), STOP_TIMEOUT_MS, "arrêt des agents").catch(() => undefined);
      await window.destroy();
    } finally {
      closing = false;
    }
  });
}

/** Question posée quand les conversations n’ont pas pu être enregistrées. */
export async function confirmCloseUnsaved(reason: string): Promise<boolean> {
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(`Les conversations des agents n’ont pas pu être enregistrées : ${reason}\n\nFermer Alfred quand même ?`, {
    title: "Fermer Alfred",
    kind: "warning",
    okLabel: "Fermer quand même",
    cancelLabel: "Rester",
  });
}

let bound = false;

/**
 * Branche la fermeture sur la fenêtre principale de l’application, une seule fois. Les fenêtres de page se ferment
 * sans étape : elles n’ont pas de conversation à enregistrer.
 */
export async function bindMainWindowClose(steps: Omit<MainWindowCloseSteps, "confirmUnsaved">): Promise<void> {
  if (bound || !inTauri) return;
  bound = true;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const window = getCurrentWindow();
  if (window.label !== "main") return;
  await registerMainWindowClose(window, { ...steps, confirmUnsaved: confirmCloseUnsaved });
}
