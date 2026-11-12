import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef } from "react";
import { IconButton } from "./Button";
import { Dialog } from "./Dialog";
import "./modal.css";

const focusable =
  "input:not([type='hidden']):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])";

/**
 * Modale d’une page : titre, bouton Fermer, corps avec marges (qui défile s’il est long), pied d’actions. Elle est
 * pilotée par `open` et `onClose` : Échap, le bouton Fermer et un clic sur le fond appellent `onClose` (le clic sur
 * le fond est refusé d’un court rebond si une saisie a commencé). À l’ouverture, le focus va au premier champ du
 * corps (ou à l’élément `autoFocus`), sinon à la première action ; il revient au déclencheur à la fermeture. Le
 * contenu n’est rendu que pendant l’ouverture : une saisie abandonnée repart de zéro.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  size = "default",
  dismissOnOutside = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Phrase sous le titre, annoncée avec lui. */
  description?: ReactNode;
  children?: ReactNode;
  /** Pied de la modale, aligné à droite : `FormActions`, ou des `Button` (Annuler puis l’action principale). */
  actions?: ReactNode;
  /** `wide` : 720 px au lieu de 480, pour un tableau ou un aperçu. */
  size?: "default" | "wide";
  /** `false` : seuls Échap et les boutons ferment la modale. */
  dismissOnOutside?: boolean;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const onCloseLatest = useRef(onClose);
  onCloseLatest.current = onClose;

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      const body = element.querySelector<HTMLElement>(".ui-modal__body");
      const footer = element.querySelector<HTMLElement>(".ui-modal__footer");
      const target =
        element.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ??
        body?.querySelector<HTMLElement>("input:not([type='hidden']):not(:disabled), select, textarea") ??
        body?.querySelector<HTMLElement>(focusable) ??
        footer?.querySelector<HTMLElement>(focusable) ??
        element;
      target.focus();
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

  return (
    <Dialog
      ref={dialog}
      className={`ui-modal${size === "wide" ? " ui-modal--wide" : ""}`}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      tabIndex={-1}
      dismissOnOutside={dismissOnOutside}
      onDismiss={() => onCloseLatest.current()}
      onCancel={(event) => {
        // Échap : la modale reste ouverte tant que le parent ne passe pas `open` à faux.
        event.preventDefault();
        onCloseLatest.current();
      }}
    >
      {open ? (
        <>
          <header className="ui-modal__header">
            <div className="ui-modal__heading">
              <h2 id={`${id}-title`}>{title}</h2>
              {description ? <p id={`${id}-description`}>{description}</p> : null}
            </div>
            <IconButton label="Fermer" onClick={() => onCloseLatest.current()}>
              <X size={16} aria-hidden="true" />
            </IconButton>
          </header>
          <div className="ui-modal__body">{children}</div>
          {actions ? <footer className="ui-modal__footer">{actions}</footer> : null}
        </>
      ) : null}
    </Dialog>
  );
}
