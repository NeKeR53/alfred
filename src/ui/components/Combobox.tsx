import { ChevronDown, LoaderCircle, Search, X } from "lucide-react";
import {
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";
import { ListboxOption } from "./ChoiceButton";
import { TextInput, useFormField } from "./FormControls";
import "./combobox.css";

export type ComboboxProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "onFocus" | "onBlur" | "onKeyDown"
> & {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  normalize?: (value: string) => string;
};

type ListPosition = { top: number; left: number; width: number; maxHeight: number };

/**
 * Saisie libre avec suggestions sélectionnables, utilisée pour les champs qui
 * doivent reprendre une valeur existante sans empêcher la création d'une nouvelle valeur.
 */
export function Combobox({ value, options, onChange, normalize, id, className, ...props }: ComboboxProps) {
  const field = useFormField();
  const generatedId = useId().replaceAll(":", "");
  // Dans un `FormField`, le champ prend l’identifiant que vise son libellé ; message et invalidité suivent par TextInput.
  const inputId = id ?? field?.controlId ?? `combobox-${generatedId}`;
  const listId = `${inputId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<ListPosition>();

  const filteredOptions = useMemo(() => {
    const query = value.trim().toLocaleLowerCase("fr");
    return options.filter((option) => option.toLocaleLowerCase("fr").includes(query));
  }, [options, value]);

  const updatePosition = useCallback(() => {
    const input = inputRef.current;
    if (!input || typeof window === "undefined") return;
    const rect = input.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const width = Math.min(rect.width, Math.max(0, window.innerWidth - margin * 2));
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
    const availableBelow = Math.max(0, window.innerHeight - rect.bottom - margin - gap);
    const availableAbove = Math.max(0, rect.top - margin - gap);
    const showBelow = availableBelow >= 160 || availableBelow >= availableAbove;
    const maxHeight = Math.max(96, Math.min(280, showBelow ? availableBelow : availableAbove));
    setPosition({ top: showBelow ? rect.bottom + gap : rect.top - gap - maxHeight, left, width, maxHeight });
  }, []);

  useEffect(() => {
    if (!open || !filteredOptions.length) return;
    updatePosition();
    const reposition = () => updatePosition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [filteredOptions.length, open, updatePosition]);

  useEffect(() => {
    if (activeIndex >= filteredOptions.length) setActiveIndex(filteredOptions.length ? 0 : -1);
  }, [activeIndex, filteredOptions.length]);

  const selectOption = (option: string) => {
    onChange(option);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  const handleBlur = () => {
    window.setTimeout(() => {
      if (!containerRef.current?.contains(document.activeElement)) setOpen(false);
    }, 0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === ",") {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (!filteredOptions.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        activeIndex < 0
          ? direction === 1
            ? 0
            : filteredOptions.length - 1
          : (activeIndex + direction + filteredOptions.length) % filteredOptions.length;
      setOpen(true);
      setActiveIndex(nextIndex);
      return;
    }
    if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      selectOption(filteredOptions[activeIndex]);
    }
  };

  const list =
    open && filteredOptions.length && position && typeof document !== "undefined"
      ? createPortal(
          <div
            id={listId}
            className="combobox__list"
            role="listbox"
            aria-label="Suggestions"
            style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
          >
            {filteredOptions.map((option, index) => (
              <ListboxOption
                key={option}
                id={`${listId}-option-${index}`}
                selected={index === activeIndex}
                className={index === activeIndex ? "combobox__option is-active" : "combobox__option"}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectOption(option);
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                {option}
              </ListboxOption>
            ))}
          </div>,
          // Dans une modale, la liste doit rejoindre la couche supérieure du <dialog> pour rester visible.
          containerRef.current?.closest("dialog") ?? document.body,
        )
      : null;

  return (
    <div ref={containerRef} className={["combobox", className ?? ""].filter(Boolean).join(" ")}>
      <TextInput
        {...props}
        width="full"
        id={inputId}
        ref={inputRef}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && filteredOptions.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
        onChange={(event) => {
          const nextValue = normalize ? normalize(event.target.value) : event.target.value;
          onChange(nextValue);
          setOpen(true);
          setActiveIndex(0);
        }}
        onFocus={() => {
          setOpen(Boolean(filteredOptions.length));
          setActiveIndex(filteredOptions.length ? 0 : -1);
        }}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
      {list}
    </div>
  );
}

export type SearchComboboxProps<Option> = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "defaultValue" | "onChange" | "onFocus" | "onBlur" | "onKeyDown" | "onSelect"
> & {
  label: string;
  value: string;
  options: readonly Option[];
  onChange: (value: string) => void;
  onSelect: (option: Option) => void;
  closeOnSelect?: boolean;
  getOptionKey: (option: Option) => string;
  getOptionLabel: (option: Option) => string;
  renderOption?: (option: Option) => ReactNode;
  isOptionDisabled?: (option: Option) => boolean;
  minQueryLength?: number;
  loading?: boolean;
  loadingMessage?: string;
  emptyMessage?: string;
};

/** Recherche distante avec sélection d'une entité dans une liste ancrée au champ. */
export function SearchCombobox<Option>({
  label,
  value,
  options,
  onChange,
  onSelect,
  closeOnSelect = true,
  getOptionKey,
  getOptionLabel,
  renderOption,
  isOptionDisabled,
  minQueryLength = 1,
  loading = false,
  loadingMessage = "Recherche en cours…",
  emptyMessage = "Aucun résultat.",
  id,
  className,
  disabled,
  ...inputProps
}: SearchComboboxProps<Option>) {
  const field = useFormField();
  const generatedId = useId().replaceAll(":", "");
  const inputId = id ?? field?.controlId ?? `search-combobox-${generatedId}`;
  const listId = `${inputId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<ListPosition>();
  const queryReady = value.trim().length >= minQueryLength;
  const visible = open && value.trim().length > 0;

  const firstEnabledIndex = useCallback(
    () => options.findIndex((option) => !isOptionDisabled?.(option)),
    [isOptionDisabled, options],
  );

  const updatePosition = useCallback(() => {
    const input = inputRef.current;
    if (!input || typeof window === "undefined") return;
    const rect = input.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const width = Math.min(Math.max(rect.width, 320), Math.max(0, window.innerWidth - margin * 2));
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
    const availableBelow = Math.max(0, window.innerHeight - rect.bottom - margin - gap);
    const availableAbove = Math.max(0, rect.top - margin - gap);
    const showBelow = availableBelow >= 160 || availableBelow >= availableAbove;
    const maxHeight = Math.max(96, Math.min(320, showBelow ? availableBelow : availableAbove));
    setPosition({ top: showBelow ? rect.bottom + gap : rect.top - gap - maxHeight, left, width, maxHeight });
  }, []);

  useEffect(() => {
    if (!visible) return;
    updatePosition();
    const reposition = () => updatePosition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [visible, updatePosition]);

  useEffect(() => {
    const activeOption = options[activeIndex];
    if (activeIndex >= options.length || (activeOption !== undefined && isOptionDisabled?.(activeOption)))
      setActiveIndex(firstEnabledIndex());
  }, [activeIndex, firstEnabledIndex, isOptionDisabled, options]);

  const closeList = () => {
    setOpen(false);
    setActiveIndex(-1);
  };

  const selectOption = (option: Option) => {
    if (isOptionDisabled?.(option)) return;
    onSelect(option);
    if (closeOnSelect) closeList();
    else setActiveIndex(firstEnabledIndex());
    inputRef.current?.focus();
  };

  const moveActive = (direction: 1 | -1) => {
    if (!options.length) return;
    let nextIndex = activeIndex;
    for (let step = 0; step < options.length; step += 1) {
      nextIndex =
        nextIndex < 0
          ? direction === 1
            ? 0
            : options.length - 1
          : (nextIndex + direction + options.length) % options.length;
      const nextOption = options[nextIndex];
      if (nextOption !== undefined && !isOptionDisabled?.(nextOption)) {
        setActiveIndex(nextIndex);
        return;
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeList();
      return;
    }
    if (event.key === "Tab") {
      closeList();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!queryReady || !options.length) return;
      event.preventDefault();
      setOpen(true);
      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" && visible && activeIndex >= 0) {
      event.preventDefault();
      const selectedOption = options[activeIndex];
      if (selectedOption !== undefined) selectOption(selectedOption);
    }
  };

  const listSemantics =
    queryReady && !loading && options.length
      ? { role: "listbox" as const, "aria-label": `Résultats pour ${label.toLocaleLowerCase("fr")}` }
      : { role: "status" as const };
  const list =
    visible && position && typeof document !== "undefined"
      ? createPortal(
          <div
            id={listId}
            className="combobox__list search-combobox__list"
            {...listSemantics}
            aria-busy={loading || undefined}
            style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
          >
            {!queryReady ? (
              <div className="search-combobox__status">{`Saisissez au moins ${minQueryLength} caractères.`}</div>
            ) : loading ? (
              <div className="search-combobox__status">
                <LoaderCircle className="is-spinning" size={16} aria-hidden="true" />
                {loadingMessage}
              </div>
            ) : options.length ? (
              options.map((option, index) => {
                const optionDisabled = isOptionDisabled?.(option) ?? false;
                return (
                  <ListboxOption
                    key={getOptionKey(option)}
                    id={`${listId}-option-${index}`}
                    selected={index === activeIndex}
                    disabled={optionDisabled}
                    aria-label={getOptionLabel(option)}
                    className={`combobox__option search-combobox__option${index === activeIndex ? " is-active" : ""}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectOption(option);
                    }}
                    onMouseEnter={() => {
                      if (!optionDisabled) setActiveIndex(index);
                    }}
                  >
                    {renderOption?.(option) ?? getOptionLabel(option)}
                  </ListboxOption>
                );
              })
            ) : (
              <div className="search-combobox__status">{emptyMessage}</div>
            )}
          </div>,
          // Dans une modale, la liste doit rejoindre la couche supérieure du <dialog> pour rester visible.
          containerRef.current?.closest("dialog") ?? document.body,
        )
      : null;

  return (
    <div ref={containerRef} className={["search-combobox", className ?? ""].filter(Boolean).join(" ")}>
      <Search className="search-combobox__icon" size={16} aria-hidden="true" />
      <TextInput
        {...inputProps}
        width="full"
        id={inputId}
        ref={inputRef}
        type="text"
        value={value}
        disabled={disabled}
        role="combobox"
        // Dans un `FormField`, le libellé visible nomme le champ ; `label` ne sert alors qu’aux boutons voisins.
        aria-label={inputProps["aria-label"] ?? (field ? undefined : label)}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={listId}
        aria-activedescendant={
          visible && queryReady && !loading && activeIndex >= 0 && options[activeIndex] !== undefined
            ? `${listId}-option-${activeIndex}`
            : undefined
        }
        onChange={(event) => {
          const nextValue = event.target.value;
          onChange(nextValue);
          setOpen(nextValue.trim().length > 0);
          setActiveIndex(-1);
        }}
        onFocus={() => {
          setOpen(value.trim().length > 0);
          setActiveIndex(firstEnabledIndex());
        }}
        onBlur={() =>
          window.setTimeout(() => {
            if (!containerRef.current?.contains(document.activeElement)) closeList();
          }, 0)
        }
        onKeyDown={handleKeyDown}
      />
      {value ? (
        <IconButton
          className="search-combobox__clear"
          label={`Effacer ${label.toLocaleLowerCase("fr")}`}
          tooltip="Effacer"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange("");
            closeList();
            inputRef.current?.focus();
          }}
        >
          <X size={14} aria-hidden="true" />
        </IconButton>
      ) : null}
      {list}
    </div>
  );
}

export type MultiSelectComboboxProps<Value extends string = string> = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "onFocus" | "onBlur" | "onKeyDown"
> & {
  label: string;
  values: readonly Value[];
  options: readonly Value[];
  onChange: (values: Value[]) => void;
  formatOption?: (value: Value) => string;
  placeholder?: string;
  /**
   * `"options"` (par défaut) limite la sélection aux options ; `"custom"` accepte aussi
   * une valeur saisie, proposée en tête de liste puis ajoutée avec Entrée.
   */
  valueMode?: MultiSelectValueMode;
  /** Normalise une valeur saisie en mode `"custom"` ; une valeur vide est ignorée. */
  normalizeCustomValue?: (value: string) => string;
  /**
   * `"compact"` (par défaut, barres de filtres) montre deux valeurs puis « +N » ; `"all"` (formulaires) les montre
   * toutes, sur plusieurs lignes si besoin.
   */
  display?: "compact" | "all";
  /** Texte de la zone de recherche une fois des valeurs choisies (affichage `"all"`), par exemple « Rechercher… ». */
  searchPlaceholder?: string;
};

export type MultiSelectValueMode = "options" | "custom";

/** Combobox de filtre avec sélection multiple et liste rendue dans le top-layer. */
export function MultiSelectCombobox<Value extends string>({
  label,
  values,
  options,
  onChange,
  formatOption,
  placeholder = "Toutes les valeurs",
  valueMode = "options",
  normalizeCustomValue = (value) => value.trim(),
  display = "compact",
  searchPlaceholder,
  id,
  className,
  ...inputProps
}: MultiSelectComboboxProps<Value>) {
  const field = useFormField();
  const generatedId = useId().replaceAll(":", "");
  const inputId = id ?? field?.controlId ?? `multi-combobox-${generatedId}`;
  const listId = `${inputId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const keyboardNavigationRef = useRef(false);
  const portalTarget =
    typeof document !== "undefined" ? (containerRef.current?.closest("dialog") ?? document.body) : null;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<ListPosition>();
  const optionLabel = (value: Value) => formatOption?.(value) ?? value;
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("fr")
      .trim();
    return options.filter((option) =>
      [option, formatOption?.(option) ?? option].some((candidate) =>
        candidate
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLocaleLowerCase("fr")
          .includes(normalizedQuery),
      ),
    );
  }, [options, query, formatOption]);
  const customValue = valueMode === "custom" ? (normalizeCustomValue(query) as Value) : undefined;
  const entries: readonly Value[] =
    customValue && !options.includes(customValue) && !values.includes(customValue)
      ? [customValue, ...filteredOptions]
      : filteredOptions;
  const listMounted = open && entries.length > 0 && position !== undefined && portalTarget !== null;

  const updatePosition = useCallback(() => {
    const control = controlRef.current;
    if (!control || typeof window === "undefined") return;
    const rect = control.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const width = Math.min(rect.width, Math.max(0, window.innerWidth - margin * 2));
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
    const availableBelow = Math.max(0, window.innerHeight - rect.bottom - margin - gap);
    const availableAbove = Math.max(0, rect.top - margin - gap);
    const showBelow = availableBelow >= 160 || availableBelow >= availableAbove;
    const maxHeight = Math.max(96, Math.min(280, showBelow ? availableBelow : availableAbove));
    const nextPosition = { top: showBelow ? rect.bottom + gap : rect.top - gap - maxHeight, left, width, maxHeight };
    setPosition((current) =>
      current &&
      current.top === nextPosition.top &&
      current.left === nextPosition.left &&
      current.width === nextPosition.width &&
      current.maxHeight === nextPosition.maxHeight
        ? current
        : nextPosition,
    );
  }, []);

  useEffect(() => {
    if (!open || !entries.length) return;
    updatePosition();
    const reposition = (event: Event) => {
      if (event.target !== listRef.current) updatePosition();
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [entries.length, open, updatePosition]);

  useEffect(() => {
    if (activeIndex >= entries.length) setActiveIndex(entries.length ? 0 : -1);
  }, [activeIndex, entries.length]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !listMounted) return;
    const popover = list as HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void };
    popover.showPopover?.();
    return () => {
      if (list.matches(":popover-open")) popover.hidePopover?.();
    };
  }, [listMounted]);

  useEffect(() => {
    if (!listMounted || activeIndex < 0 || !keyboardNavigationRef.current) return;
    keyboardNavigationRef.current = false;
    listRef.current?.children.item(activeIndex)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listMounted]);

  useEffect(() => {
    const dialog = containerRef.current?.closest("dialog");
    if (!dialog) return;
    const close = () => {
      setOpen(false);
      setQuery("");
    };
    dialog.addEventListener("close", close);
    return () => dialog.removeEventListener("close", close);
  }, []);

  const closeList = () => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  };

  const toggleOption = (option: Value) => {
    onChange(values.includes(option) ? values.filter((value) => value !== option) : [...values, option]);
    setQuery("");
    setOpen(true);
    setActiveIndex(0);
    inputRef.current?.focus();
  };

  const removeValue = (value: Value) => {
    onChange(values.filter((item) => item !== value));
    inputRef.current?.focus();
  };

  const handleBlur = () => {
    window.setTimeout(() => {
      if (!containerRef.current?.contains(document.activeElement)) closeList();
    }, 0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeList();
      return;
    }
    if (event.key === "Tab") {
      closeList();
      return;
    }
    if (event.key === "Backspace" && !query && values.length) {
      const lastValue = values.at(-1);
      if (lastValue !== undefined) removeValue(lastValue);
      return;
    }
    if (!entries.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        activeIndex < 0
          ? direction === 1
            ? 0
            : entries.length - 1
          : (activeIndex + direction + entries.length) % entries.length;
      keyboardNavigationRef.current = true;
      setOpen(true);
      setActiveIndex(nextIndex);
      return;
    }
    if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      const selectedOption = entries[activeIndex];
      if (selectedOption !== undefined) toggleOption(selectedOption);
    }
  };

  const visibleValues = display === "all" ? values : values.slice(0, 2);
  const list =
    listMounted && position && portalTarget
      ? createPortal(
          <div
            ref={listRef}
            id={listId}
            className="combobox__list multi-combobox__list"
            role="listbox"
            aria-label={`Options de ${label.toLocaleLowerCase("fr")}`}
            aria-multiselectable="true"
            popover="manual"
            style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
          >
            {entries.map((option, index) => {
              const selected = values.includes(option);
              const active = index === activeIndex;
              const custom = option === customValue && !options.includes(option);
              return (
                <ListboxOption
                  key={option}
                  id={`${listId}-option-${index}`}
                  selected={selected}
                  className={`combobox__option multi-combobox__option${active ? " is-active" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    toggleOption(option);
                  }}
                  onMouseEnter={() => {
                    keyboardNavigationRef.current = false;
                    setActiveIndex(index);
                  }}
                >
                  <span className={`multi-combobox__mark${selected ? " is-selected" : ""}`} aria-hidden="true">
                    {selected ? "✓" : ""}
                  </span>
                  <span>{custom ? `Ajouter « ${optionLabel(option)} »` : optionLabel(option)}</span>
                </ListboxOption>
              );
            })}
          </div>,
          portalTarget,
        )
      : null;

  return (
    <div
      ref={containerRef}
      className={["multi-combobox", display === "all" ? "multi-combobox--all" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      <div ref={controlRef} className="multi-combobox__control">
        <div className="multi-combobox__values">
          {visibleValues.map((value) => (
            <span className="multi-combobox__chip" key={value} title={optionLabel(value)}>
              <span>{optionLabel(value)}</span>
              <button
                type="button"
                aria-label={`Retirer ${optionLabel(value)}`}
                disabled={inputProps.disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => removeValue(value)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          {values.length > visibleValues.length ? (
            <span className="multi-combobox__more">+{values.length - visibleValues.length}</span>
          ) : null}
          <TextInput
            {...inputProps}
            width="full"
            id={inputId}
            ref={inputRef}
            className="multi-combobox__input"
            type="text"
            value={query}
            placeholder={values.length ? (display === "all" ? (searchPlaceholder ?? "") : "") : placeholder}
            role="combobox"
            aria-haspopup="listbox"
            aria-label={inputProps["aria-label"] ?? (field ? undefined : label)}
            aria-autocomplete="list"
            aria-expanded={open && entries.length > 0}
            aria-controls={listId}
            aria-activedescendant={open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              setActiveIndex(0);
            }}
            onFocus={() => {
              setOpen(Boolean(entries.length));
              setActiveIndex(entries.length ? 0 : -1);
            }}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
          />
        </div>
        <IconButton
          className="multi-combobox__toggle"
          label={`${open ? "Fermer" : "Afficher"} les options de ${label.toLocaleLowerCase("fr")}`}
          tooltip={open ? "Fermer les options" : "Afficher les options"}
          aria-expanded={open && entries.length > 0}
          aria-controls={listId}
          disabled={inputProps.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const nextOpen = !open;
            if (nextOpen) inputRef.current?.focus();
            setOpen(nextOpen);
            setQuery(nextOpen ? query : "");
            setActiveIndex(nextOpen && entries.length ? 0 : -1);
          }}
        >
          <ChevronDown className="multi-combobox__chevron" size={16} aria-hidden="true" />
        </IconButton>
      </div>
      {list}
    </div>
  );
}
