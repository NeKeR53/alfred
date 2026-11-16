import { EmptyState, IconButton, LoadingSkeleton } from "@alfred/ui";
import { MoveHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { notify } from "../../../shell/notifications";
import "./pdf-preview.css";

/**
 * Aperçu d’un PDF, repris de `PdfPreview` de OneApp : le document est lu localement, puis ses pages sont dessinées
 * par pdf.js. L’aperçu ne dépend donc pas de la visionneuse PDF de WebView2, que l’entreprise peut désactiver.
 * `source` change dès que le document change ; il est alors relu.
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
  if (!state?.bytes) return <LoadingSkeleton variant="page" rows={6} label="Lecture du PDF…" />;
  return <PdfPages label={label} bytes={state.bytes} />;
}

type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;
type PageSize = { width: number; height: number };

const zoomSteps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
const clampZoom = (value: number) => Math.min(zoomSteps[zoomSteps.length - 1], Math.max(zoomSteps[0], value));

/**
 * Pages du PDF l’une sous l’autre. Chaque page garde sa place dès le chargement, mais n’est dessinée qu’à
 * l’approche de la zone visible : un long plan de tests reste fluide. Zoom ajusté à la largeur par défaut ;
 * Ctrl+molette zoome autour du pointeur et un glisser à la souris déplace le document.
 */
function PdfPages({ label, bytes }: { label: string; bytes: Uint8Array }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PdfDocument>();
  const [sizes, setSizes] = useState<PageSize[]>();
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [current, setCurrent] = useState(1);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      setWidth(Math.max(0, Math.floor(element.clientWidth - padding)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocument | undefined;
    let destroy: (() => void) | undefined;
    void (async () => {
      const pdfjs = await import("pdfjs-dist");
      if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      }
      // pdf.js transfère le tampon reçu : une copie garde les octets générés intacts pour un nouveau rendu.
      const task = pdfjs.getDocument({ data: bytes.slice() });
      destroy = () => void task.destroy();
      loaded = await task.promise;
      const next: PageSize[] = [];
      for (let number = 1; number <= loaded.numPages; number += 1) {
        const viewport = (await loaded.getPage(number)).getViewport({ scale: 1 });
        next.push({ width: viewport.width, height: viewport.height });
      }
      if (cancelled) return;
      setDocument(loaded);
      setSizes(next);
    })().catch((cause: unknown) => {
      if (cancelled) return;
      notify({
        tone: "error",
        title: "Aperçu PDF indisponible",
        description: cause instanceof Error ? cause.message : "Le PDF n’a pas pu être affiché.",
      });
    });
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [bytes]);

  const widest = sizes ? Math.max(...sizes.map((size) => size.width)) : 0;
  const fitScale = widest && width ? width / widest : 1;
  const scale = zoom === "fit" ? fitScale : zoom;
  const percent = Math.round(scale * 100);
  // Le zoom garde en haut de la zone la page qui y était : on ne se perd pas dans le document.
  const anchorPage = useRef<number>(undefined);
  const changeZoom = (next: "fit" | number) => {
    anchorPage.current = current;
    setZoom(next);
  };
  const zoomBy = (direction: 1 | -1) => {
    const next =
      direction > 0
        ? zoomSteps.find((step) => step > scale + 0.01)
        : [...zoomSteps].reverse().find((step) => step < scale - 0.01);
    if (next) changeZoom(next);
  };
  // Zoom à la molette : le point sous le pointeur reste sous le pointeur.
  const wheelAnchor = useRef<{ x: number; y: number; ratio: number }>(undefined);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    const element = scroller.current;
    if (!element || !sizes) return;
    const onWheel = (event: WheelEvent) => {
      // La molette seule fait défiler ; Ctrl+molette zoome, comme dans les visionneuses PDF.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const previous = scaleRef.current;
      const next = clampZoom(previous * Math.exp(-event.deltaY * 0.0015));
      if (Math.abs(next - previous) < 0.001) return;
      const box = element.getBoundingClientRect();
      wheelAnchor.current = { x: event.clientX - box.left, y: event.clientY - box.top, ratio: next / previous };
      setZoom(next);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [sizes]);
  // Glisser à la souris : déplace le document, utile une fois zoomé.
  const drag = useRef<{ x: number; y: number; left: number; top: number }>(undefined);
  useLayoutEffect(() => {
    void scale;
    const element = scroller.current;
    const wheel = wheelAnchor.current;
    wheelAnchor.current = undefined;
    if (element && wheel) {
      element.scrollLeft = (element.scrollLeft + wheel.x) * wheel.ratio - wheel.x;
      element.scrollTop = (element.scrollTop + wheel.y) * wheel.ratio - wheel.y;
      return;
    }
    const page = anchorPage.current;
    anchorPage.current = undefined;
    if (!element || !page) return;
    const target = element.children[page - 1];
    if (target) element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - 16;
  }, [scale]);
  // Page affichée : celle qui occupe le haut de la zone visible.
  const trackPage = () => {
    const element = scroller.current;
    if (!element) return;
    const limit = element.getBoundingClientRect().top + element.clientHeight / 3;
    let page = 1;
    for (const [index, child] of [...element.children].entries())
      if (child.getBoundingClientRect().top <= limit) page = index + 1;
    setCurrent(page);
  };

  return (
    <div className="pdf-preview">
      <div className="pdf-preview__bar" role="toolbar" aria-label="Affichage de l’aperçu">
        <span className="pdf-preview__position" aria-live="polite">
          {sizes ? `Page ${current} / ${sizes.length}` : "Affichage du PDF…"}
        </span>
        <IconButton
          label="Zoom arrière"
          size="compact"
          disabled={!sizes || scale <= zoomSteps[0] + 0.01}
          onClick={() => zoomBy(-1)}
        >
          <ZoomOut size={16} aria-hidden="true" />
        </IconButton>
        <span className="pdf-preview__zoom">{percent} %</span>
        <IconButton
          label="Zoom avant"
          size="compact"
          disabled={!sizes || scale >= zoomSteps[zoomSteps.length - 1] - 0.01}
          onClick={() => zoomBy(1)}
        >
          <ZoomIn size={16} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Ajuster à la largeur"
          size="compact"
          aria-pressed={zoom === "fit"}
          disabled={!sizes}
          onClick={() => changeZoom("fit")}
        >
          <MoveHorizontal size={16} aria-hidden="true" />
        </IconButton>
      </div>
      <div
        ref={scroller}
        className="pdf-preview__pages"
        role="document"
        aria-label={sizes ? `${label}, ${sizes.length} page${sizes.length > 1 ? "s" : ""}` : label}
        aria-busy={!sizes || undefined}
        onScroll={trackPage}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.pointerType !== "mouse") return;
          const element = event.currentTarget;
          drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
          element.setPointerCapture(event.pointerId);
          element.classList.add("is-dragging");
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          event.currentTarget.scrollLeft = start.left - (event.clientX - start.x);
          event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
        }}
        onPointerUp={(event) => {
          drag.current = undefined;
          event.currentTarget.classList.remove("is-dragging");
        }}
        onPointerCancel={(event) => {
          drag.current = undefined;
          event.currentTarget.classList.remove("is-dragging");
        }}
      >
        {document && sizes
          ? sizes.map((size, index) => (
              <PdfPage
                // biome-ignore lint/suspicious/noArrayIndexKey: une page du PDF n’a pas d’autre identité que son numéro.
                key={index}
                document={document}
                number={index + 1}
                size={size}
                scale={scale}
                root={scroller}
              />
            ))
          : null}
      </div>
    </div>
  );
}

/** Une page : sa place est réservée, elle n’est dessinée qu’à l’approche de la zone visible puis à chaque zoom. */
function PdfPage({
  document,
  number,
  size,
  scale,
  root,
}: {
  document: PdfDocument;
  number: number;
  size: PageSize;
  scale: number;
  root: { current: HTMLDivElement | null };
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const element = holder.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setNear(entries.some((entry) => entry.isIntersecting)), {
      root: root.current,
      rootMargin: "600px 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    const element = holder.current;
    if (!near || !element) return;
    let cancelled = false;
    let cancelRender: (() => void) | undefined;
    void (async () => {
      const page = await document.getPage(number);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.setAttribute("aria-hidden", "true");
      const task = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      cancelRender = () => task.cancel();
      await task.promise;
      // Le dessin précédent reste affiché jusqu’au nouveau : pas de clignotement pendant le zoom.
      if (!cancelled) element.replaceChildren(canvas);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      cancelRender?.();
    };
  }, [document, near, number, scale]);

  return (
    <div
      ref={holder}
      className="pdf-preview__page"
      style={{ width: Math.floor(size.width * scale), height: Math.floor(size.height * scale) }}
    />
  );
}

/** Fonction stable qui appelle toujours la dernière version reçue. */
function useLatest<T extends (...args: never[]) => unknown>(callback: T) {
  const [holder] = useState(() => ({ current: callback }));
  holder.current = callback;
  const [stable] = useState(() => ((...args: Parameters<T>) => holder.current(...args)) as T);
  return stable;
}
