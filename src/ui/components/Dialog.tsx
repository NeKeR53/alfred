import { type DialogHTMLAttributes, forwardRef, useRef } from "react";

/**
 * Modale native de la coquille (une page utilise `Modal`), même règle partout : Échap la ferme, un clic sur le fond aussi, sauf si une saisie a commencé
 * depuis son ouverture (rien ne doit être perdu sur un clic égaré) ou si une opération en cours refuse la fermeture
 * (`onCancel` qui appelle `preventDefault`). Dans ces deux cas, elle reste ouverte et le signale d’un court rebond.
 * `dismissOnOutside={false}` réserve la fermeture à Échap et aux boutons, pour une modale qui l’exige.
 * `onDismiss` remplace la fermeture native du clic sur le fond, pour une modale pilotée par son parent.
 */
/**
 * Ferme une modale par le même chemin qu’Échap : un `onCancel` qui refuse (opération en cours) la garde ouverte.
 * À utiliser pour les boutons Fermer et Annuler d’une modale. Renvoie vrai si elle s’est fermée.
 */
export function requestDialogClose(element: HTMLDialogElement | null | undefined) {
  if (!element?.open) return false;
  if (!element.dispatchEvent(new Event("cancel", { cancelable: true }))) return false;
  element.close();
  return true;
}

export const Dialog = forwardRef<
  HTMLDialogElement,
  DialogHTMLAttributes<HTMLDialogElement> & { dismissOnOutside?: boolean; onDismiss?: () => void }
>(function Dialog(
  {
    className,
    dismissOnOutside = true,
    onDismiss,
    onPointerDown,
    onPointerUp,
    onInputCapture,
    onChangeCapture,
    onClose,
    ...props
  },
  ref,
) {
  const startedOutside = useRef(false);
  const edited = useRef(false);
  const outside = (element: HTMLDialogElement, x: number, y: number) => {
    const rect = element.getBoundingClientRect();
    return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
  };
  const refuse = (element: HTMLDialogElement) => {
    element.classList.remove("ui-dialog--refused");
    // Relance l’animation même sur deux refus rapprochés.
    void element.offsetWidth;
    element.classList.add("ui-dialog--refused");
  };
  return (
    <dialog
      {...props}
      ref={ref}
      className={["ui-dialog", className ?? ""].filter(Boolean).join(" ")}
      onInputCapture={(event) => {
        edited.current = true;
        onInputCapture?.(event);
      }}
      onChangeCapture={(event) => {
        edited.current = true;
        onChangeCapture?.(event);
      }}
      onClose={(event) => {
        // La prochaine ouverture repart sans saisie.
        edited.current = false;
        onClose?.(event);
      }}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.classList.remove("ui-dialog--refused");
        props.onAnimationEnd?.(event);
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        startedOutside.current =
          !event.defaultPrevented &&
          event.button === 0 &&
          event.target === event.currentTarget &&
          outside(event.currentTarget, event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        const element = event.currentTarget;
        const clickedOutside =
          !event.defaultPrevented &&
          startedOutside.current &&
          event.target === element &&
          outside(element, event.clientX, event.clientY);
        startedOutside.current = false;
        if (!clickedOutside || !dismissOnOutside) return;
        if (edited.current) {
          refuse(element);
          return;
        }
        if (onDismiss) {
          onDismiss();
          return;
        }
        // Même chemin qu’Échap : un `onCancel` qui refuse (opération en cours) garde la modale ouverte.
        if (!requestDialogClose(element)) refuse(element);
      }}
    />
  );
});
