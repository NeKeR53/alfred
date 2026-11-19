import { useEffect, useRef } from "react";
import { SearchField } from "../ui/components/SearchField";
import { setTopBarQuery, useTopBarSearches } from "./topBarSearchStore";
import "./top-bar-search.css";

/**
 * Recherche de la page affichée, en tête des actions de la barre du haut, comme `PageTopBar` de OneApp : 240 px qui
 * se réduisent, ⌘F ou Ctrl+F y mène (même depuis la page, qui remonte le raccourci). Rien quand la page n’en déclare
 * pas.
 */
export function TopBarSearch({ reference }: { reference: string }) {
  const declaration = useTopBarSearches((state) => state.declared[reference]);
  const query = useTopBarSearches((state) => state.queries[reference] ?? "");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!declaration) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "f" || event.defaultPrevented) return;
      // Une fenêtre modale par-dessus la page garde le clavier.
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [declaration]);

  if (!declaration) return null;
  return (
    <SearchField
      className={`shell-topbar__search${query ? " has-query" : ""}`}
      inputRef={input}
      label={declaration.label}
      placeholder={declaration.placeholder}
      autoComplete="off"
      spellCheck={false}
      aria-keyshortcuts="Meta+F Control+F"
      value={query}
      onChange={(event) => setTopBarQuery(reference, event.target.value, "shell")}
      onClear={() => setTopBarQuery(reference, "", "shell")}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Échap efface la recherche, puis, le champ vide, rend la main (la loupe se referme dans une barre étroite).
        event.preventDefault();
        event.stopPropagation();
        if (query) setTopBarQuery(reference, "", "shell");
        else event.currentTarget.blur();
      }}
    />
  );
}
