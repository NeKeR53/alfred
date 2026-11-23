import type { PDFDocumentProxy } from "pdfjs-dist";

export type PdfDocument = PDFDocumentProxy;
export interface PdfPageSize {
  width: number;
  height: number;
}

/**
 * Ouvre un PDF avec pdf.js, chargé à la première demande (environ 1,7 Mo, dans un morceau à part du runtime).
 *
 * Le cadre d’une page refuse les workers, les cadres et les plugins (`worker-src`, `frame-src`, `object-src 'none'`) :
 * ni la visionneuse du navigateur ni le worker de pdf.js n’y sont permis. pdf.js tourne donc sur le fil principal,
 * par son « faux worker » (`globalThis.pdfjsWorker`). Sans réseau, les polices standard non incluses dans le PDF
 * sont remplacées par celles du système.
 */
export async function openPdf(bytes: Uint8Array): Promise<{
  document: PdfDocument;
  sizes: PdfPageSize[];
  destroy: () => void;
}> {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs")]);
  const scope = globalThis as { pdfjsWorker?: unknown };
  scope.pdfjsWorker ??= worker;
  // pdf.js transfère le tampon reçu : une copie garde les octets de l’appelant intacts.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const destroy = () => void task.destroy();
  try {
    const document = await task.promise;
    const sizes: PdfPageSize[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const viewport = (await document.getPage(number)).getViewport({ scale: 1 });
      sizes.push({ width: viewport.width, height: viewport.height });
    }
    return { document, sizes, destroy };
  } catch (cause) {
    destroy();
    const kind = (cause as { name?: string } | null)?.name;
    if (kind === "PasswordException") throw new Error("Ce PDF est protégé par un mot de passe.");
    if (kind === "InvalidPDFException") throw new Error("Ce fichier n’est pas un PDF valide, ou il est abîmé.");
    throw cause;
  }
}

/** Dessine une page dans un nouveau canevas ; `cancel` interrompt le dessin en cours. */
export function renderPdfPage(document: PdfDocument, number: number, scale: number) {
  let cancelRender: (() => void) | undefined;
  let cancelled = false;
  const promise = (async () => {
    const page = await document.getPage(number);
    if (cancelled) throw new Error("Dessin annulé");
    const viewport = page.getViewport({ scale });
    const ratio = window.devicePixelRatio || 1;
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.setAttribute("aria-hidden", "true");
    const task = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
    cancelRender = () => task.cancel();
    await task.promise;
    return canvas;
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      cancelRender?.();
    },
  };
}
