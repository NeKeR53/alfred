import { cn } from "cn";
import { type FocusEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import "./inline-edit.css";

/**
 * Validation de la saisie : `line` enregistre à Entrée, `multiline` garde Entrée pour les retours à la ligne et
 * enregistre à Ctrl+Entrée.
 */
export type InlineEditMode = "line" | "multiline";

export type InlineEditor<T> = {
  value: T;
  setValue: (value: T) => void;
  /** Enregistre la valeur donnée, ou la saisie en cours. */
  commit: (value?: T) => void;
  pending: boolean;
  label: string;
};

function sameValue(left: unknown, right: unknown) {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || !left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function InlineEditControl<T>({
  value,
  label,
  mode,
  onSave,
  onClose,
  renderEditor,
}: {
  value: T;
  label: string;
  mode: InlineEditMode;
  onSave: (value: T) => unknown;
  onClose: (restoreFocus: boolean) => void;
  renderEditor: (editor: InlineEditor<T>) => ReactNode;
}) {
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState(false);
  const draftRef = useRef(value);
  // Une fois fermé (Entrée, Échap) ou pendant l’enregistrement, le blur qui suit n’enregistre rien de plus.
  const busy = useRef(false);
  const setValue = (next: T) => {
    draftRef.current = next;
    setDraft(next);
  };
  const commit = async (next = draftRef.current, restoreFocus = false) => {
    if (busy.current) return;
    setValue(next);
    if (sameValue(next, value)) {
      busy.current = true;
      onClose(restoreFocus);
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      await onSave(next);
      onClose(restoreFocus);
    } catch {
      // L’échec est signalé par l’appelant : la saisie reste ouverte avec sa valeur pour être corrigée.
      busy.current = false;
      setPending(false);
    }
  };
  const cancel = () => {
    if (busy.current) return;
    busy.current = true;
    onClose(true);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: la saisie qu’il contient porte le clavier ; ce conteneur ne fait qu’enregistrer ou annuler.
    <div
      className={cn("inline-edit__editor", `inline-edit__editor--${mode}`)}
      aria-busy={pending || undefined}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        // Une liste de mentions ouverte garde Entrée et Échap pour elle.
        if (event.nativeEvent.isComposing || event.defaultPrevented) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
          return;
        }
        if (event.key !== "Enter" || event.shiftKey) return;
        if (mode === "multiline" && !(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        void commit(draftRef.current, true);
      }}
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        void commit();
      }}
    >
      {renderEditor({ value: draft, setValue, commit: (next) => void commit(next), pending, label })}
    </div>
  );
}

/** Clic sur un élément qui a sa propre action (lien, bouton, champ) : il ne doit pas ouvrir la saisie. */
const ownAction =
  "a, button, input, select, textarea, summary, [role='button'], [role='link'], [contenteditable='true']";

/**
 * Valeur modifiable sur place : un fin contour au survol, sans fond ni icône ; un clic, F2 ou Entrée ouvre la
 * saisie au même endroit, Entrée ou un clic à côté enregistre, Échap annule. Un bouton invisible porte le clavier et
 * le nom accessible. Un enregistrement refusé (promesse rejetée) laisse la saisie ouverte avec sa valeur.
 */
export function InlineEdit<T>({
  value,
  label,
  mode = "line",
  disabled = false,
  editing: controlledEditing,
  onEditingChange,
  onSave,
  renderEditor,
  className,
  children,
}: {
  value: T;
  /** Nom du champ, repris par le bouton d’ouverture et le nom accessible de la saisie. */
  label: string;
  mode?: InlineEditMode;
  disabled?: boolean;
  /** Ouverture pilotée par l’appelant, par exemple depuis une commande ou un menu. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onSave: (value: T) => unknown;
  renderEditor: (editor: InlineEditor<T>) => ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [localEditing, setLocalEditing] = useState(false);
  const editing = !disabled && (controlledEditing ?? localEditing);
  const displayRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const setEditing = (next: boolean) => {
    setLocalEditing(next);
    onEditingChange?.(next);
  };
  useEffect(() => {
    if (editing || !restoreFocus.current) return;
    restoreFocus.current = false;
    displayRef.current?.querySelector<HTMLButtonElement>(".inline-edit__trigger")?.focus();
  }, [editing]);

  if (editing)
    return (
      <div className={cn("inline-edit", "is-editing", className)}>
        <InlineEditControl
          value={value}
          label={label}
          mode={mode}
          onSave={onSave}
          onClose={(focus) => {
            restoreFocus.current = focus;
            setEditing(false);
          }}
          renderEditor={renderEditor}
        />
      </div>
    );
  if (disabled) return <div className={cn("inline-edit", className)}>{children}</div>;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: la valeur garde sa sémantique (titre, texte) ; le bouton invisible porte le clavier, le clic est un raccourci.
    <div
      ref={displayRef}
      className={cn("inline-edit", "is-editable", className)}
      onClick={(event) => {
        const target = event.target as Element;
        if (target.closest(ownAction) && !target.closest(".inline-edit__trigger")) return;
        // Une sélection de texte reste une sélection.
        if (window.getSelection()?.toString()) return;
        setEditing(true);
      }}
      onDoubleClick={() => setEditing(true)}
      onKeyDown={(event) => {
        if (event.key !== "F2") return;
        event.preventDefault();
        setEditing(true);
      }}
    >
      <div className="inline-edit__value">{children}</div>
      <button
        type="button"
        className="inline-edit__trigger visually-hidden"
        aria-keyshortcuts="F2"
        onClick={(event) => {
          event.stopPropagation();
          setEditing(true);
        }}
      >
        {`Modifier « ${label} »`}
      </button>
    </div>
  );
}
