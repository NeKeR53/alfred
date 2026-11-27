import { useCallback, useState } from "react";
import { useShell } from "./store";

/**
 * Dernière valeur connue d’une rubrique d’Alfred (Réglages, marketplace, listes du cœur), gardée le temps du
 * lancement et par espace de travail. Rouverte, la rubrique s’affiche tout de suite avec elle, sans « Chargement… » ;
 * sa relecture se fait en arrière-plan et remplace la valeur à son arrivée. C’est la règle des pages (`useAlfredState`,
 * SDK.md, section 3, « L’interface d’abord ») appliquée aux pages d’Alfred.
 *
 * S’emploie comme `useState` : `const [entries, setEntries] = useLastKnown<VaultEntry[] | undefined>("coffre", undefined)`.
 */
const known = new Map<string, unknown>();

export function useLastKnown<T>(key: string, initial: T): [T, (next: T | ((current: T) => T)) => void] {
  const space = useShell((state) => state.snapshot?.path ?? "");
  const slot = `${space}\u0000${key}`;
  const [value, setValue] = useState<T>(() => (known.has(slot) ? (known.get(slot) as T) : initial));
  const set = useCallback(
    (next: T | ((current: T) => T)) =>
      setValue((current) => {
        const chosen = typeof next === "function" ? (next as (current: T) => T)(current) : next;
        known.set(slot, chosen);
        return chosen;
      }),
    [slot],
  );
  return [value, set];
}

/** Oublie tout (tests, espace fermé). */
export function forgetLastKnown() {
  known.clear();
}
