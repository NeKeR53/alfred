/** Page que cette fenêtre affiche seule, posée par Rust avant le chargement (`page_windows.rs`) ; sinon `null`. */
export function pageWindowReference(): string | null {
  const value = (window as { __ALFRED_PAGE_WINDOW__?: { reference?: unknown } }).__ALFRED_PAGE_WINDOW__;
  return typeof value?.reference === "string" ? value.reference : null;
}
