/**
 * `usePageState` : comme `useState`, mais Alfred retient la valeur quand on quitte la page et la rend quand on y
 * revient (recherche, filtres, vue, onglet, ligne ouverte). La clé est propre à la page ; la valeur doit tenir en
 * JSON et rester petite. Hors d’un cadre de page (tests, coquille), c’est un `useState`.
 */
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { useFrameServices } from "./services";

export function usePageState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const services = useFrameServices();
  const [value, setValue] = useState<T>(() => {
    const kept = services.state?.initial[key];
    if (kept !== undefined) return kept as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  const first = useRef(true);
  useEffect(() => {
    // La valeur de départ est déjà connue d’Alfred (ou c’est la valeur par défaut) : rien à envoyer.
    if (first.current) {
      first.current = false;
      return;
    }
    services.state?.set(key, value);
  }, [key, value, services]);
  return [value, setValue];
}
