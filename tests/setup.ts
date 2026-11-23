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

afterEach(() => cleanup());

// Comme `main.tsx`, chaque rendu de test est posé sous `SocleProvider` : confirmations, formulaires en modale et
// toasts de socle-ui en ont besoin. Sans file de notifications : un rendu vide reste vide. Un test peut passer
// son propre `wrapper`.
vi.mock("@testing-library/react", async (importOriginal) => {
  const library = await importOriginal<typeof import("@testing-library/react")>();
  const { createElement } = await import("react");
  const { SocleProvider } = await import("socle-ui");
  const Wrapper = ({ children }: { children: import("react").ReactNode }) =>
    createElement(SocleProvider, { platform: "macos", storageKey: "alfred-test", children });
  const render: typeof library.render = ((
    ui: Parameters<typeof library.render>[0],
    options?: Parameters<typeof library.render>[1],
  ) => library.render(ui, { wrapper: Wrapper, ...options })) as typeof library.render;
  return { ...library, render };
});
