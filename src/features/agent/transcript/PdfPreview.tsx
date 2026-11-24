import { useEffect, useState } from "react";
import { DocumentViewer, EmptyState, Skeleton, SkeletonGroup } from "socle-ui";
import { notify } from "../../../shell/notifications";

/** Charge pdf.js et son worker, à la demande : le premier aperçu seul paie le chargement. */
async function loadPdf() {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  return pdfjs;
}

/**
 * Aperçu d’un PDF, repris de `PdfPreview` de OneApp : le document est lu localement, puis montré par le
 * `DocumentViewer` de Socle (pdf.js). L’aperçu ne dépend donc pas de la visionneuse PDF de WebView2, que l’entreprise
 * peut désactiver. `source` change dès que le document change ; il est alors relu.
 */
export function PdfPreview({
  label,
  source,
  generate,
}: {
  /** Nom accessible de l’aperçu, par exemple « Aperçu du PDF de la SRS ». */
  label: string;
  /** Empreinte du contenu rendu (par exemple son JSON) : un changement relance la génération. */
  source: string;
  generate: () => Promise<Uint8Array>;
}) {
  const [state, setState] = useState<{ source: string; bytes?: Uint8Array; failed?: boolean }>();
  const generateLatest = useLatest(generate);

  useEffect(() => {
    let active = true;
    // Un court délai évite de régénérer à chaque frappe quand le contenu change pendant l’aperçu.
    const timer = window.setTimeout(() => {
      generateLatest().then(
        (bytes) => {
          if (active) setState({ source, bytes });
        },
        (cause) => {
          if (!active) return;
          setState({ source, failed: true });
          notify({
            tone: "error",
            title: "Aperçu PDF indisponible",
            description: cause instanceof Error ? cause.message : "Le PDF n’a pas pu être lu.",
          });
        },
      );
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [generateLatest, source]);

  if (state?.failed && state.source === source)
    return <EmptyState size="compact" title="Aperçu PDF indisponible" description="Le fichier n’a pas pu être lu." />;
  if (!state?.bytes)
    return (
      <SkeletonGroup label="Lecture du PDF…">
        <Skeleton shape="rect" height={360} />
      </SkeletonGroup>
    );
  return <DocumentViewer label={label} data={state.bytes} name="apercu.pdf" type="application/pdf" loadPdf={loadPdf} />;
}

/** Fonction stable qui appelle toujours la dernière version reçue. */
function useLatest<T extends (...args: never[]) => unknown>(callback: T) {
  const [holder] = useState(() => ({ current: callback }));
  holder.current = callback;
  const [stable] = useState(() => ((...args: Parameters<T>) => holder.current(...args)) as T);
  return stable;
}
