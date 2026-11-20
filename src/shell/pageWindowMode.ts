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
