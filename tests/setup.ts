import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom n’a ni `ResizeObserver` ni `matchMedia` : les composants de socle-ui (AppShell, Table, SettingsPage…) les
// lisent pour leur mise en page. Ces versions vides suffisent aux tests, qui ne mesurent rien.
class EmptyResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= EmptyResizeObserver as unknown as typeof ResizeObserver;
if (typeof window !== "undefined") {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => {};
}

// Chaque rendu de test est enveloppé dans `SocleProvider`, comme l’app (src/main.tsx) : confirmations, formulaires
// en modale et toasts de socle-ui en dépendent. Un test peut toujours passer son propre `wrapper`.
vi.mock("@testing-library/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@testing-library/react")>();
  const { createElement } = await import("react");
  const { SocleProvider } = await import("socle-ui");
  const { notifications } = await import("../src/shell/socle");
  const Wrapper = ({ children }: { children: import("react").ReactNode }) =>
    createElement(SocleProvider, {
      density: "desktop",
      platform: "macos",
      storageKey: "test",
      notifications,
      children,
    });
  return {
    ...original,
    render: ((ui: Parameters<typeof original.render>[0], options: Parameters<typeof original.render>[1] = {}) =>
      original.render(ui, { wrapper: Wrapper, ...options })) as typeof original.render,
  };
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  // La file de notifications est commune à l’app : un test ne voit pas les toasts du précédent.
  const { notifications } = await import("../src/shell/socle");
  notifications.clear();
  notifications.toastQueue.clear();
});
