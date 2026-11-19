/**
 * Où en est l’accueil. Seul le parcours lui-même est gardé ici, en mémoire : chaque étape relit l’état réel (espaces
 * récents, marketplaces branchés, réglages), rien n’est enregistré à part.
 */
import { create } from "zustand";

export type WelcomeStep = "hello" | "space" | "modules" | "basics" | "ready";

export const WELCOME_STEPS: readonly WelcomeStep[] = ["hello", "space", "modules", "basics", "ready"];

interface WelcomeState {
  /** Vrai pendant le parcours : il reste affiché une fois l’espace ouvert, jusqu’à « Ouvrir Alfred ». */
  active: boolean;
  /** Relancé depuis Réglages › Général : un espace est déjà ouvert, l’accueil se ferme sans rien perdre. */
  replay: boolean;
  step: WelcomeStep;
  /** Modules importés pendant ce parcours, dans l’ordre : leur configuration suit « Ouvrir Alfred ». */
  imported: Array<{ id: string; name: string }>;
}

export const useWelcome = create<WelcomeState>(() => ({ active: false, replay: false, step: "hello", imported: [] }));

/** Lance le parcours complet ; `replay` depuis les Réglages, quand un espace est déjà ouvert. */
export function startWelcome(replay = false) {
  useWelcome.setState({ active: true, replay, step: "hello", imported: [] });
}

export function goToStep(step: WelcomeStep) {
  useWelcome.setState({ step });
}

export function closeWelcome() {
  useWelcome.setState({ active: false, replay: false, step: "hello", imported: [] });
}
