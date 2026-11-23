import { type ReactNode, useId } from "react";

/**
 * Groupe titré de cases à cocher, de boutons radio ou d’interrupteurs : la légende nomme le groupe, l’aide et
 * l’erreur lui sont reliées. Pour un champ seul, `FormField`.
 */
export function Fieldset({
  legend,
  hint,
  error,
  layout = "stack",
  disabled,
  children,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  /** Message d’erreur du groupe (« Choisissez au moins un jour. ») ; marque le groupe invalide. */
  error?: ReactNode;
  /** `row` : options courtes côte à côte, renvoyées à la ligne si la place manque. */
  layout?: "stack" | "row";
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const messageId = error || hint ? `${id}-message` : undefined;
  return (
    <fieldset
      className={`ui-fieldset${layout === "row" ? " ui-fieldset--row" : ""}`}
      aria-describedby={messageId}
      aria-invalid={error ? true : undefined}
      disabled={disabled}
    >
      <legend className="ui-fieldset__legend">{legend}</legend>
      <div className="ui-fieldset__options">{children}</div>
      {error ? (
        <div className="ui-fieldset__message ui-fieldset__message--error" id={messageId} role="alert">
          {error}
        </div>
      ) : hint ? (
        <p className="ui-fieldset__message" id={messageId}>
          {hint}
        </p>
      ) : null}
    </fieldset>
  );
}
