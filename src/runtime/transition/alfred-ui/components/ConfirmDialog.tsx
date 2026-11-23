import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

export type ConfirmDialogTone = "danger" | "default";

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  message?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Dialogue modal de confirmation. Le focus initial porte sur l’action d’annulation,
 * Échap annule et le focus revient à l’élément déclencheur à la fermeture.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = "Annuler",
  tone = "default",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      element.querySelector<HTMLButtonElement>("[data-confirm-cancel]")?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  useEffect(() => {
    if (open) return;
    const target = invoker.current;
    invoker.current = null;
    if (target?.isConnected) target.focus();
  }, [open]);

  const requestCancel = () => {
    if (!busyRef.current) onCancel();
  };

  return (
    <Dialog
      ref={dialog}
      className="confirm-dialog"
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={message ? `${id}-message` : undefined}
      onCancel={(event) => {
        event.preventDefault();
        requestCancel();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        requestCancel();
      }}
    >
      <h2 id={`${id}-title`} className="confirm-dialog__title">
        {title}
      </h2>
      {message ? (
        <div id={`${id}-message`} className="confirm-dialog__message">
          {message}
        </div>
      ) : null}
      <div className="form-actions">
        <Button data-confirm-cancel disabled={busy} onClick={requestCancel}>
          {cancelLabel}
        </Button>
        <Button variant={tone === "danger" ? "danger" : "primary"} loading={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

export type ConfirmOptions = Omit<ConfirmDialogProps, "open" | "busy" | "onConfirm" | "onCancel">;

/**
 * Remplace `window.confirm` : `await confirm(options)` résout `true` à la confirmation
 * et `false` à l’annulation. L’élément `confirmDialog` doit être rendu par l’appelant.
 */
export function useConfirm() {
  const [options, setOptions] = useState<ConfirmOptions>();
  const resolver = useRef<((value: boolean) => void) | undefined>(undefined);

  const settle = useCallback((value: boolean) => {
    const resolve = resolver.current;
    resolver.current = undefined;
    setOptions(undefined);
    resolve?.(value);
  }, []);

  const confirm = useCallback((next: ConfirmOptions) => {
    resolver.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  useEffect(() => () => resolver.current?.(false), []);

  const confirmDialog = (
    <ConfirmDialog
      title=""
      confirmLabel=""
      {...options}
      open={options !== undefined}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return { confirm, confirmDialog };
}
