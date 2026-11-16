/**
 * Ce que jsdom n’a pas et que l’application entière utilise : préférences du système, mesure des éléments,
 * modales natives. À importer avant l’application dans chaque parcours.
 */
import { installDialogPolyfill } from "../../src/ui/dialog.test-helper";

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

Element.prototype.scrollIntoView ??= () => undefined;
// Les infobulles passent par l’API Popover.
HTMLElement.prototype.showPopover ??= () => undefined;
HTMLElement.prototype.hidePopover ??= () => undefined;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

installDialogPolyfill();
