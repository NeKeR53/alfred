import type { ReactNode } from "react";
import { Button } from "./Button";

export function FormActions({
  onCancel,
  onSubmit,
  submitLabel,
  cancelLabel = "Annuler",
  pendingLabel,
  pending = false,
  disabled = false,
  cancelDisabled = pending,
  form,
  submitIcon,
  submitKeyShortcuts,
  children,
}: {
  /** Sans action d’annulation (panneau latéral fermé par son en-tête), le bouton n’est pas affiché. */
  onCancel?: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
  cancelLabel?: string;
  pendingLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  cancelDisabled?: boolean;
  form?: string;
  submitIcon?: ReactNode;
  /** Raccourci clavier de soumission annoncé par `aria-keyshortcuts`, par exemple `Control+S`. */
  submitKeyShortcuts?: string;
  children?: ReactNode;
}) {
  const resolvedPendingLabel = pendingLabel ?? submitLabel ?? "Enregistrement…";

  return (
    <div className="form-actions">
      {children}
      {onCancel ? (
        <Button className="form-actions__cancel" onClick={onCancel} disabled={cancelDisabled}>
          {cancelLabel}
        </Button>
      ) : null}
      {submitLabel ? (
        <Button
          className="form-actions__submit"
          variant="primary"
          type={form ? "submit" : "button"}
          form={form}
          onClick={onSubmit}
          disabled={disabled}
          loading={pending}
          loadingLabel={resolvedPendingLabel}
          aria-keyshortcuts={submitKeyShortcuts}
        >
          {submitIcon}
          {submitLabel}
        </Button>
      ) : null}
    </div>
  );
}
