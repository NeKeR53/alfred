import { X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef } from "react";
import { IconButton } from "./Button";
import { Dialog } from "./Dialog";
import "./modal.css";

const focusable =
  "input:not([type='hidden']):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])";

const widths = { small: " ui-modal--small", default: "", wide: " ui-modal--wide" } as const;

/** Éléments atteignables au clavier dans la modale, dans l’ordre du document (les éléments masqués exclus). */
function tabbable(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(focusable)).filter(
    (element) => element.tabIndex >= 0 && !element.closest("[hidden], [inert]") && element.getClientRects().length > 0,
  );
}

/**
 * Garde Tab et Maj+Tab dans la modale. Le `<dialog>` natif laisse le focus sortir vers la fenêtre parente : dans le
 * cadre isolé d’une page, il quitterait la page pour la coquille.
 */
function trapTab(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const items = tabbable(event.currentTarget);
  if (items.length === 0) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const inside = active instanceof Node && event.currentTarget.contains(active) && active !== event.currentTarget;
  if (event.shiftKey && (!inside || active === first)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Modale d’une page : titre, bouton Fermer, corps avec marges (qui défile s’il est long), pied d’actions. Elle est
 * pilotée par `open` et `onClose` : Échap, le bouton Fermer et un clic sur le fond appellent `onClose` (le clic sur
 * le fond est refusé d’un court rebond si une saisie a commencé). À l’ouverture, le focus va au premier champ du
 * corps (ou à l’élément `autoFocus`), sinon à la première action ; il revient au déclencheur à la fermeture. Le
 * contenu n’est rendu que pendant l’ouverture : une saisie abandonnée repart de zéro. Tab et Maj+Tab restent dans la
 * modale. Pendant une opération (`busy`), rien ne la ferme : ni Échap, ni le fond, ni le bouton Fermer.
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
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Phrase sous le titre, annoncée avec lui. */
  description?: ReactNode;
  children?: ReactNode;
  /** Pied de la modale, aligné à droite : `FormActions`, ou des `Button` (Annuler puis l’action principale). */
  actions?: ReactNode;
  /** `small` : 360 px, une question et un champ ; `default` : 480 px, un formulaire court ; `wide` : 720 px, un tableau ou un aperçu. */
  size?: "small" | "default" | "wide";
  /** `false` : seuls Échap et les boutons ferment la modale. */
  dismissOnOutside?: boolean;
  /** Opération en cours (enregistrement) : la modale ne se ferme pas et son bouton Fermer est désactivé. */
  busy?: boolean;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const onCloseLatest = useRef(onClose);
  onCloseLatest.current = onClose;
  const busyLatest = useRef(busy);
  busyLatest.current = busy;
  const requestClose = () => {
    if (!busyLatest.current) onCloseLatest.current();
  };

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
      className={`ui-modal${widths[size] ?? ""}`}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      aria-busy={busy || undefined}
      tabIndex={-1}
      dismissOnOutside={dismissOnOutside && !busy}
      onDismiss={requestClose}
      onKeyDown={trapTab}
      onCancel={(event) => {
        // Échap : la modale reste ouverte tant que le parent ne passe pas `open` à faux.
        event.preventDefault();
        requestClose();
      }}
    >
      {open ? (
        <>
          <header className="ui-modal__header">
            <div className="ui-modal__heading">
              <h2 id={`${id}-title`}>{title}</h2>
              {description ? <p id={`${id}-description`}>{description}</p> : null}
            </div>
            <IconButton label="Fermer" disabled={busy} onClick={requestClose}>
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
