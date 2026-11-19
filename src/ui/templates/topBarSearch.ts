import { useEffect, useRef } from "react";
import { useFrameServices } from "./services";

/**
 * Place la recherche d’un gabarit (`CollectionPage`, `Page search`) dans la barre du haut d’Alfred, quand la page
 * tourne dans son cadre. Le texte reste celui de l’appelant (`value`, `onChange`) : une frappe dans la barre appelle
 * `onChange`, et un changement venu de la page (« Effacer les filtres ») s’y affiche. Rend `true` quand la barre du
 * haut porte la recherche ; `false` hors d’un cadre (tests, coquille), où le gabarit garde son propre champ.
 */
export function useTopBarSearchField(
  search: { label: string; placeholder?: string } | undefined,
  value: string,
  onChange: (value: string) => void,
): boolean {
  const declare = useFrameServices().topBarSearch;
  const handle = useRef<{ setQuery(query: string): void; dispose(): void } | null>(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  // Dernier texte que la barre montre : un changement de `value` venu d’ailleurs lui est envoyé.
  const shown = useRef(value);
  const label = search?.label;
  const placeholder = search?.placeholder;

  useEffect(() => {
    if (!declare || label === undefined) return;
    const declared = declare({ label, placeholder }, (query) => {
      shown.current = query;
      if (query !== latest.current.value) latest.current.onChange(query);
    });
    handle.current = declared;
    // Un texte déjà retenu par la page passe dans la barre.
    if (latest.current.value) declared.setQuery(latest.current.value);
    return () => {
      declared.dispose();
      if (handle.current === declared) handle.current = null;
    };
  }, [declare, label, placeholder]);

  useEffect(() => {
    if (shown.current === value) return;
    shown.current = value;
    handle.current?.setQuery(value);
  }, [value]);

  return Boolean(declare && search);
}
