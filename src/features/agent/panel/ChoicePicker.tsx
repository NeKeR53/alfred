/* Repris de OneApp : components/shared/ChoicePicker.tsx. */
import { Check, ChevronDown } from "lucide-react";
import { type CSSProperties, type RefObject, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { useContextMenuDismiss } from "../../../ui/components/useContextMenuDismiss";
import "./choice-picker.css";

/**
 * Position fixe d’une fenêtre de choix ouverte depuis un bouton de la ligne sous la saisie : une boîte de dialogue
 * qui défile ne la coupe pas. Elle s’ouvre du côté préféré, sinon de l’autre si la place manque, et reste dans la
 * fenêtre, alignée sur le bord droit (`align="end"`) ou gauche du bouton.
 */
export function usePickerPosition(
  open: boolean,
  placement: "above" | "below",
  trigger: RefObject<HTMLElement | null>,
  popover: RefObject<HTMLElement | null>,
  align: "start" | "end" = "end",
) {
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open) return setPosition(undefined);
    const place = () => {
      const button = trigger.current?.getBoundingClientRect();
      const height = popover.current?.offsetHeight ?? 0;
      if (!button) return;
      const below = window.innerHeight - button.bottom - 6 - 8;
      const above = button.top - 6 - 8;
      const downward = placement === "below" ? below >= height || below >= above : above < height && below > above;
      const horizontal =
        align === "end" ? { right: Math.max(8, window.innerWidth - button.right) } : { left: Math.max(8, button.left) };
      setPosition(
        downward
          ? { top: Math.min(button.bottom + 6, window.innerHeight - height - 8), ...horizontal }
          : { bottom: Math.min(window.innerHeight - button.top + 6, window.innerHeight - height - 8), ...horizontal },
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [align, open, placement, popover, trigger]);
  return position;
}

export type PickerChoice = { value: string; label: string };

/**
 * Bouton discret (texte et chevron) qui ouvre une liste de choix flottante : modèle, produit, composant, branche.
 * Même déclencheur et même fenêtre partout.
 */
export function ChoicePicker({
  name,
  value,
  choices,
  placeholder,
  disabled,
  onChange,
  placement = "above",
  align = "start",
}: {
  name: string;
  value: string;
  choices: readonly PickerChoice[];
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  placement?: "above" | "below";
  align?: "start" | "end";
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const position = usePickerPosition(open, placement, trigger, popover, align);
  const close = useCallback(() => setOpen(false), []);
  useContextMenuDismiss(open, `[data-choice-picker="${id}"]`, close);
  const current = choices.find((choice) => choice.value === value);
  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="choice-picker" data-choice-picker={id}>
      <button
        ref={trigger}
        type="button"
        className="choice-picker__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`${name} : ${current?.label ?? placeholder}`}
        disabled={disabled || !choices.length}
        onClick={() => setOpen((visible) => !visible)}
      >
        <span>{current?.label ?? placeholder}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={popover}
          id={`${id}-list`}
          className="choice-picker__popover choice-picker__list"
          style={position ?? { visibility: "hidden" }}
          role="listbox"
          aria-label={name}
          onKeyDown={(event) => {
            const options = [...(popover.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
            const index = options.indexOf(document.activeElement as HTMLElement);
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              options[(index + step + options.length) % options.length]?.focus();
            }
          }}
        >
          {choices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="option"
              aria-selected={choice.value === value}
              className="choice-picker__option"
              // Le choix actuel reçoit le focus à l’ouverture, pour parcourir la liste au clavier.
              ref={(element) => {
                if (element && choice.value === value && document.activeElement === trigger.current) element.focus();
              }}
              onClick={() => choose(choice.value)}
            >
              <span>{choice.label}</span>
              {choice.value === value ? <Check size={13} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
