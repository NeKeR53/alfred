/**
 * Mode « données d’exemple », réglé module par module dans la base d’Alfred (voir `src-tauri/src/examples.rs`) :
 * les pages du module s’affichent même sans compte, et ses fonctions de connecteur rendent leurs exemples au lieu
 * d’appeler le service. La vue de l’espace (`snapshot.examples`) dit quels modules sont dans ce mode.
 */
import { invoke } from "../lib/native";
import type { Snapshot } from "../lib/types";
import { useShell } from "./store";

export function inExampleMode(snapshot: Snapshot | null | undefined, module: string): boolean {
  return snapshot?.examples?.includes(module) ?? false;
}

/** Le module est affiché avec ses données d’exemple. */
export function useExampleMode(module: string): boolean {
  return useShell((state) => inExampleMode(state.snapshot, module));
}

/** Active ou quitte le mode pour un module ; la vue de l’espace est relue aussitôt. */
export async function setExampleMode(module: string, on: boolean): Promise<void> {
  const examples = await invoke<string[]>("examples.set", { module, on });
  const { snapshot } = useShell.getState();
  if (snapshot) useShell.setState({ snapshot: { ...snapshot, examples } });
}
