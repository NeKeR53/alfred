/**
 * Moteurs que des composants de `socle-ui` demandent à l’app, chargés à la première demande dans un morceau à part :
 * xterm.js pour `Terminal` (`engine={loadTerminal}`) et pdf.js pour `DocumentViewer` (`loadPdf={loadPdf}`).
 */

/** xterm.js et son ajustement à la place, pour `<Terminal engine={loadTerminal} … />` de `socle-ui`. */
export async function loadTerminal() {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/xterm/css/xterm.css"),
  ]);
  return { Terminal, FitAddon };
}

/**
 * pdf.js, pour `<DocumentViewer loadPdf={loadPdf} … />` de `socle-ui`. Le cadre d’une page refuse les workers : pdf.js
 * tourne sur le fil principal, par son « faux worker » (`globalThis.pdfjsWorker`). Sans réseau, les polices standard
 * absentes du PDF sont remplacées par celles du système.
 */
export async function loadPdf() {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs")]);
  const scope = globalThis as { pdfjsWorker?: unknown };
  scope.pdfjsWorker ??= worker;
  return pdfjs;
}
