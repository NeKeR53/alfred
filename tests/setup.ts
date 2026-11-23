import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { createNotifications, SocleProvider } from "socle-ui";
import { afterEach, expect, vi } from "vitest";

// Les parcours de `tests/` rendent l’application entière : comme `src/main.tsx`, ils passent dans un `SocleProvider`
// (confirmations, actions, mémoire des choix). Un test qui donne son propre `wrapper` le garde.
vi.mock("@testing-library/react", async (original) => {
  const library = await original<typeof import("@testing-library/react")>();
  const render = ((ui: Parameters<typeof library.render>[0], options?: object) => {
    if (!/[\\/]tests[\\/][^\\/]+\.test\.tsx?$/.test(expect.getState().testPath ?? ""))
      return library.render(ui, options);
    const notifications = createNotifications();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SocleProvider, { density: "desktop", notifications, children });
    return library.render(ui, { wrapper, ...options });
  }) as typeof library.render;
  return { ...library, render };
});

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
