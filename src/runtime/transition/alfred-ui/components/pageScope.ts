import { createContext, useContext } from "react";

/**
 * Vrai sous `Page`, la racine d’une page de l’espace (et des réglages de la coquille qui l’emploient) : les champs y
 * prennent la largeur de leur contenu au lieu de s’étirer. La coquille, hors `Page`, garde ses champs pleine largeur.
 */
export const PageScope = createContext(false);

export function useInPage() {
  return useContext(PageScope);
}
