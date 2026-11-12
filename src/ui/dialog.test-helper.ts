/** jsdom n’implémente pas `<dialog>` modal : ouverture, fermeture et Échap (événement `cancel`) suffisent aux tests. */
export function installDialogPolyfill() {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

/** Échap dans une modale native : `cancel`, puis la fermeture si rien ne l’a empêchée. */
export function pressEscapeInDialog(dialog: HTMLDialogElement) {
  if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
}
