/** Page que cette fenêtre affiche seule, posée par Rust avant le chargement (`page_windows.rs`) ; sinon `null`. */
export function pageWindowReference(): string | null {
  const value = (window as { __ALFRED_PAGE_WINDOW__?: { reference?: unknown } }).__ALFRED_PAGE_WINDOW__;
  return typeof value?.reference === "string" ? value.reference : null;
}

/** Paramètres de la fenêtre ouverte sur un élément précis (`shell.openWindow(page, { params })`), sinon `null`. */
export function pageWindowParams(): Record<string, unknown> | null {
  const value = (window as { __ALFRED_PAGE_WINDOW__?: { params?: unknown } }).__ALFRED_PAGE_WINDOW__;
  const params = value?.params;
  return params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : null;
}

/**
 * Fenêtre secondaire : une fenêtre de page, ou la fenêtre Agent détachée (`agentsWindow.ts`). Elle relit l’espace que
 * la fenêtre principale a ouvert, sans le rouvrir : rouvrir fermerait les fenêtres de page, elle comprise.
 */
export function isSecondaryWindow(): boolean {
  return (
    pageWindowReference() !== null ||
    (window as { __ALFRED_AGENTS_WINDOW__?: unknown }).__ALFRED_AGENTS_WINDOW__ === true
  );
}
