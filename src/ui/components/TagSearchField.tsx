/**
 * Recherche à étiquettes : on tape, des suggestions s’affichent, la première prête ; Entrée en fait une étiquette
 * (le texte saisi lui-même quand rien ne correspond, ou après Échap qui ferme les suggestions) ; la croix d’une étiquette, ou Retour arrière sur un champ vide, la retire.
 * Les étiquettes sont les critères de la recherche ; le texte en cours de frappe est aussi rendu (`onQueryChange`)
 * pour filtrer au fil de la saisie.
 */
import { Search, X } from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import "./essentials.css";

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("fr").trim();

export interface TagSearchFieldProps {
  /** Nom accessible du champ : « Rechercher un contact ». */
  label: string;
  /** Étiquettes posées. */
  tags: readonly string[];
  onTagsChange: (tags: string[]) => void;
  /** Suggestions proposées pendant la frappe (filtrées sans accents ni casse, celles déjà posées en moins). */
  suggestions?: readonly string[];
  /** Texte affiché pour une étiquette ou une suggestion (`ville:lyon` → « Ville : Lyon »). */
  formatTag?: (tag: string) => string;
  /** Faux : seules les suggestions deviennent des étiquettes. Vrai par défaut : tout texte saisi en devient une. */
  allowFreeText?: boolean;
  /** Texte en cours de frappe, à chaque changement. */
  onQueryChange?: (query: string) => void;
  placeholder?: string;
}

export function TagSearchField({
  label,
  tags,
  onTagsChange,
  suggestions = [],
  formatTag = (tag) => tag,
  allowFreeText = true,
  onQueryChange,
  placeholder = "Rechercher…",
}: TagSearchFieldProps) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const matches = useMemo(() => {
    const wanted = fold(query);
    return suggestions
      .filter((item) => !tags.includes(item))
      .filter((item) => !wanted || fold(item).includes(wanted) || fold(formatTag(item)).includes(wanted))
      .slice(0, 8);
  }, [query, suggestions, tags, formatTag]);
  const listed = open && matches.length > 0;

  // Autocomplétion : pendant la frappe, la première suggestion est prête à être prise par Entrée.
  const type = (text: string) => {
    setQuery(text);
    setOpen(true);
    setActive(text.trim() ? 0 : -1);
    onQueryChange?.(text);
  };
  const add = (tag: string) => {
    const value = tag.trim();
    if (value && !tags.includes(value)) onTagsChange([...tags, value]);
    type("");
    input.current?.focus();
  };
  const remove = (tag: string) => {
    onTagsChange(tags.filter((known) => known !== tag));
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && matches.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((index) => (index + 1) % matches.length);
    } else if (event.key === "ArrowUp" && matches.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((index) => (index <= 0 ? matches.length - 1 : index - 1));
    } else if (event.key === "Enter") {
      const chosen = listed && active >= 0 && active < matches.length ? matches[active] : undefined;
      if (chosen) {
        event.preventDefault();
        add(chosen);
      } else if (query.trim()) {
        event.preventDefault();
        // Sans texte libre, Entrée prend la seule suggestion restante.
        if (allowFreeText) add(query);
        else if (matches.length === 1) add(matches[0]);
      }
    } else if (event.key === "Escape" && (open || query)) {
      event.preventDefault();
      if (open) setOpen(false);
      else type("");
    } else if (event.key === "Backspace" && !query && tags.length > 0) {
      remove(tags[tags.length - 1]);
    }
  };

  return (
    <div className="al-tag-search">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: un clic n’importe où dans le cadre place le curseur dans le champ. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: le clavier atteint déjà le champ lui-même. */}
      <div className="al-tag-search__control" onClick={() => input.current?.focus()}>
        <Search size={16} aria-hidden="true" />
        <ul className="al-tag-search__tags" aria-label="Critères de recherche">
          {tags.map((tag) => (
            <li key={tag} className="al-tag-search__tag">
              <span>{formatTag(tag)}</span>
              <button type="button" aria-label={`Retirer ${formatTag(tag)}`} onClick={() => remove(tag)}>
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-label={label}
          aria-expanded={listed}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={listed && active >= 0 ? `${listId}-${active}` : undefined}
          value={query}
          placeholder={tags.length === 0 ? placeholder : ""}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => type(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {tags.length > 0 || query ? (
          <button
            type="button"
            className="al-tag-search__clear"
            aria-label={`Effacer ${label.toLocaleLowerCase("fr")}`}
            onClick={() => {
              onTagsChange([]);
              type("");
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={`Suggestions pour ${label}`}
        hidden={!listed}
        className="al-tag-search__list"
      >
        {matches.map((item, index) => (
          <div
            key={item}
            id={`${listId}-${index}`}
            role="option"
            tabIndex={-1}
            aria-selected={index === active}
            className="al-tag-search__option"
            // Avant la perte du focus du champ, qui fermerait la liste.
            onMouseDown={(event) => {
              event.preventDefault();
              add(item);
            }}
          >
            {formatTag(item)}
          </div>
        ))}
      </div>
    </div>
  );
}
