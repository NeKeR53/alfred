import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

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
