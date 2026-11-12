import { Search, X } from "lucide-react";
import { type InputHTMLAttributes, type RefObject, useRef } from "react";
import { IconButton } from "./Button";
import { TextInput } from "./FormControls";

export function SearchField({
  label,
  className,
  onClear,
  value,
  inputRef: externalRef,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: string;
  onClear?: () => void;
  /** Référence du champ, par exemple pour lui rendre le focus avec Ctrl+F. */
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const classes = ["page-toolbar-search", className ?? ""].filter(Boolean).join(" ");
  const hasValue = typeof value === "string" ? value.length > 0 : typeof value === "number";
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? ownRef;
  // Sans `onClear`, la croix vide le champ par le même `onChange` qu’une saisie : toutes les recherches en ont une.
  const clear =
    onClear ??
    (props.onChange
      ? () => {
          const input = inputRef.current;
          if (!input) return;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      : undefined);
  return (
    <div className={classes}>
      <Search size={16} aria-hidden="true" />
      <TextInput {...props} ref={inputRef} type="search" value={value} aria-label={label} />
      {clear && hasValue ? (
        <IconButton
          label={`Effacer ${label.toLocaleLowerCase()}`}
          tooltip="Effacer"
          onClick={() => {
            clear();
            inputRef.current?.focus();
          }}
        >
          <X size={14} aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  );
}
