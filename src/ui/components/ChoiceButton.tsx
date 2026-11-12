import { LoaderCircle } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";

type GroupMode = "radio" | "tab";
const ChoiceGroupContext = createContext<GroupMode | undefined>(undefined);

/**
 * Groupe de choix côte à côte. Il transmet son mode à ses `ChoiceButton` (qui n’ont pas à le répéter) et gère les
 * flèches, Origine et Fin : le focus suit la flèche et le choix suit le focus, comme pour des boutons radio.
 */
export function ChoiceGroup({
  label,
  className,
  children,
  selectionMode = "radio",
  appearance = "default",
}: {
  label: string;
  /** Réservé à la coquille. */
  className?: string;
  children: ReactNode;
  /** `tab` : les choix ouvrent chacun une rubrique de la page (rôles `tablist` / `tab`), au lieu de régler une valeur. */
  selectionMode?: GroupMode;
  /** `segmented` : les choix sont réunis dans un même cadre, l’actif en relief (filtre, mode d’affichage). */
  appearance?: "default" | "segmented";
}) {
  const group = useRef<HTMLDivElement>(null);
  // Sans choix actif, le premier reste joignable au clavier (sinon tous seraient hors de l’ordre de tabulation).
  useLayoutEffect(() => {
    const choices = group.current?.querySelectorAll<HTMLButtonElement>(':is([role="radio"], [role="tab"])');
    if (!choices?.length) return;
    const list = Array.from(choices);
    const current =
      list.find(
        (choice) => choice.getAttribute("aria-checked") === "true" || choice.getAttribute("aria-selected") === "true",
      ) ??
      list.find((choice) => !choice.disabled) ??
      list[0];
    for (const choice of list) choice.tabIndex = choice === current ? 0 : -1;
  });
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const choices = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(':is([role="radio"], [role="tab"]):not(:disabled)'),
    );
    if (!choices.length) return;
    const currentIndex = Math.max(0, choices.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? choices.length - 1
          : event.key === "ArrowRight" || event.key === "ArrowDown"
            ? (currentIndex + 1) % choices.length
            : (currentIndex - 1 + choices.length) % choices.length;
    event.preventDefault();
    choices[nextIndex].focus();
    choices[nextIndex].click();
  };
  const classes = ["choice-group", appearance === "segmented" ? "choice-segmented" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <ChoiceGroupContext.Provider value={selectionMode}>
      {selectionMode === "tab" ? (
        <div ref={group} className={classes} role="tablist" aria-label={label} onKeyDown={move}>
          {children}
        </div>
      ) : (
        <div ref={group} className={classes} role="radiogroup" aria-label={label} onKeyDown={move}>
          {children}
        </div>
      )}
    </ChoiceGroupContext.Provider>
  );
}

export interface ChoiceButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "aria-checked" | "aria-pressed"> {
  label: string;
  selected: boolean;
  children: ReactNode;
  size?: "default" | "compact";
  /** `label` pour un texte, `icon` (défaut) pour une icône seule, qui reçoit alors une infobulle native. */
  variant?: "icon" | "label";
  /** Par défaut celui du `ChoiceGroup` parent ; `toggle` (bascule indépendante) hors d’un groupe. */
  selectionMode?: "radio" | "toggle" | "tab";
  loading?: boolean;
}

export function ChoiceButton({
  label,
  selected,
  children,
  size = "default",
  variant = "icon",
  selectionMode,
  loading = false,
  className,
  disabled,
  title,
  type = "button",
  ...props
}: ChoiceButtonProps) {
  const groupMode = useContext(ChoiceGroupContext);
  const mode = selectionMode ?? groupMode ?? "toggle";
  const classes = [
    "choice-button",
    size === "compact" ? "choice-button--compact" : "",
    variant === "label" ? "choice-button--label" : "",
    selected ? "is-selected" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const selectionProps =
    mode === "radio"
      ? { role: "radio" as const, "aria-checked": selected, tabIndex: selected ? 0 : -1 }
      : mode === "tab"
        ? { role: "tab" as const, "aria-selected": selected, tabIndex: selected ? 0 : -1 }
        : { "aria-pressed": selected, tabIndex: props.tabIndex };

  return (
    <button
      {...props}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-label={label}
      {...selectionProps}
      title={title ?? (variant === "icon" ? label : undefined)}
    >
      {loading ? <LoaderCircle className="is-spinning" size={16} aria-hidden="true" /> : children}
    </button>
  );
}

export function ListboxOption({
  selected,
  className,
  children,
  type = "button",
  tabIndex = -1,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  selected: boolean;
}) {
  return (
    <button
      {...props}
      type={type}
      role="option"
      tabIndex={tabIndex}
      aria-selected={selected}
      className={["listbox-option", className ?? ""].filter(Boolean).join(" ")}
    >
      {children}
    </button>
  );
}
