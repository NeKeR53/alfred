import { ExternalLink, MoveHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorMessage, useFrameServices } from "../templates/services";
import { Button, IconButton } from "./Button";
import { type DocumentSource, type LoadedDocument, loadDocument } from "./documentSource";
import { EmptyState } from "./EmptyState";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { Markdown } from "./Markdown";
import { openPdf, type PdfDocument, type PdfPageSize, renderPdfPage } from "./pdfDocument";
import "./document-viewer.css";

type SourceProps =
  | { file: string; src?: never; blob?: never }
  | { src: string; file?: never; blob?: never }
  | { blob: Blob; file?: never; src?: never };

export type DocumentViewerProps = SourceProps & {
  /** Nom accessible du document, par exemple « Facture F-2026-114 ». */
  label: string;
  /** Nom du fichier : affiché dans la barre, il sert aussi à reconnaître le format (`.md`, `.pdf`). */
  name?: string;
  /** Type MIME, quand la source ne le dit pas (une adresse `blob:`) ou le dit mal. */
  type?: string;
  /** Occupe la hauteur restante (dans une `Page fill`) au lieu de sa hauteur fixe. */
  fill?: boolean;
};

type Shown =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; loaded: LoadedDocument; pdf?: { document: PdfDocument; sizes: PdfPageSize[] } };

const zoomSteps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
const clampZoom = (value: number) => Math.min(zoomSteps[zoomSteps.length - 1], Math.max(zoomSteps[0], value));

/**
 * Affiche un document dans une page : PDF (dessiné par pdf.js), image, texte brut ou Markdown. La source est un
 * fichier du module (`file`, son id), une adresse `data:`/`blob:` (`src`) ou un `Blob` (`blob`). La barre donne la
 * page, le zoom et, pour un fichier du module, l’ouverture avec l’application du système.
 */
export function DocumentViewer(props: DocumentViewerProps) {
  const { label, name, type, fill = false } = props;
  const services = useFrameServices();
  const source: DocumentSource =
    props.file !== undefined
      ? { file: props.file }
      : props.blob !== undefined
        ? { blob: props.blob }
        : { src: props.src };
  const sourceKey = props.file ?? props.src ?? props.blob;
  const [shown, setShown] = useState<Shown>({ state: "loading" });
  const readFile = services.readFile;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `source` est reconstruite à chaque rendu, `sourceKey` en est l’identité.
  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    let destroy: (() => void) | undefined;
    setShown({ state: "loading" });
    void (async () => {
      const loaded = await loadDocument(source, { name, type, readFile, track: (url) => urls.push(url) });
      if (loaded.format !== "pdf") return { state: "ready", loaded } as const;
      const pdf = await openPdf(loaded.bytes);
      destroy = pdf.destroy;
      return { state: "ready", loaded, pdf } as const;
    })().then(
      (next) => {
        if (active) setShown(next);
        else destroy?.();
      },
      (cause: unknown) => {
        if (active) setShown({ state: "failed", message: errorMessage(cause) ?? "Le document n’a pas pu être lu." });
      },
    );
    return () => {
      active = false;
      destroy?.();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [sourceKey, name, type, readFile]);

  const displayName = shown.state === "ready" ? shown.loaded.name || name || label : name || label;
  const open =
    props.file !== undefined && services.openFile
      ? () => {
          services.openFile?.(props.file).catch((cause: unknown) =>
            services.notify({
              tone: "error",
              title: "Ouverture impossible",
              description: errorMessage(cause) ?? "Le fichier n’a pas pu être ouvert.",
            }),
          );
        }
      : undefined;

  const classes = `ui-document-viewer${fill ? " ui-document-viewer--fill" : ""}`;
  if (shown.state !== "ready" || shown.loaded.format === null) {
    return (
      <section className={classes} aria-label={label}>
        {/* Format non pris en charge : l’ouverture est proposée dans le message, pas deux fois. */}
        <Bar position={displayName} open={shown.state === "ready" ? undefined : open} />
        <div className="ui-document-viewer__message">
          {shown.state === "loading" ? (
            <LoadingSkeleton variant="page" rows={6} label="Lecture du document…" />
          ) : shown.state === "failed" ? (
            <EmptyState size="compact" title="Document illisible" description={shown.message} />
          ) : (
            <EmptyState
              size="compact"
              title="Format non pris en charge"
              description={`Ce type de fichier (${describeType(shown.loaded)}) ne s’affiche pas dans une page.`}
            >
              {open ? <Button onClick={open}>Ouvrir avec l’application du système</Button> : null}
            </EmptyState>
          )}
        </div>
      </section>
    );
  }
  return (
    <Viewer
      classes={shown.pdf ? `${classes} ui-document-viewer--pdf` : classes}
      label={label}
      name={displayName}
      shown={shown}
      open={open}
    />
  );
}

function describeType(loaded: LoadedDocument) {
  const extension = loaded.name.match(/\.([a-z0-9]+)$/i)?.[1];
  return extension ? `.${extension.toLowerCase()}` : loaded.mime || "inconnu";
}

function Bar({
  position,
  open,
  zoom,
}: {
  position: string;
  open?: () => void;
  zoom?: {
    percent: number;
    canOut: boolean;
    canIn: boolean;
    fit: boolean;
    out: () => void;
    in: () => void;
    toFit: () => void;
  };
}) {
  return (
    <div className="ui-document-viewer__bar" role="toolbar" aria-label="Affichage du document">
      <span className="ui-document-viewer__position" aria-live="polite">
        {position}
      </span>
      {zoom ? (
        <>
          <IconButton label="Zoom arrière" size="compact" disabled={!zoom.canOut} onClick={zoom.out}>
            <ZoomOut size={16} aria-hidden="true" />
          </IconButton>
          <span className="ui-document-viewer__zoom">{zoom.percent} %</span>
          <IconButton label="Zoom avant" size="compact" disabled={!zoom.canIn} onClick={zoom.in}>
            <ZoomIn size={16} aria-hidden="true" />
          </IconButton>
          <IconButton label="Ajuster à la largeur" size="compact" aria-pressed={zoom.fit} onClick={zoom.toFit}>
            <MoveHorizontal size={16} aria-hidden="true" />
          </IconButton>
        </>
      ) : null}
      {open ? (
        <IconButton label="Ouvrir avec l’application du système" size="compact" onClick={open}>
          <ExternalLink size={16} aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  );
}

function Viewer({
  classes,
  label,
  name,
  shown,
  open,
}: {
  classes: string;
  label: string;
  name: string;
  shown: Extract<Shown, { state: "ready" }>;
  open?: () => void;
}) {
  const services = useFrameServices();
  const { loaded, pdf } = shown;
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [current, setCurrent] = useState(1);
  const [natural, setNatural] = useState<PdfPageSize>();

  // Largeur utile de la zone, pour « ajuster à la largeur ».
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const padding = Number.parseFloat(style.paddingLeft || "0") + Number.parseFloat(style.paddingRight || "0");
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

  const zoomable = loaded.format === "pdf" || loaded.format === "image";
  const widest = pdf ? Math.max(...pdf.sizes.map((size) => size.width)) : (natural?.width ?? 0);
  // Une image n’est jamais agrandie pour remplir la largeur ; une page de PDF, si.
  const fitScale = widest && width ? (loaded.format === "image" ? Math.min(1, width / widest) : width / widest) : 1;
  const scale = zoom === "fit" ? fitScale : zoom;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // Le zoom garde en haut de la zone la page qui y était ; Ctrl+molette garde le point sous le pointeur.
  const anchorPage = useRef<number>(undefined);
  const wheelAnchor = useRef<{ x: number; y: number; ratio: number }>(undefined);
  const changeZoom = (next: "fit" | number) => {
    anchorPage.current = pdf ? current : undefined;
    setZoom(next);
  };
  const zoomBy = (direction: 1 | -1) => {
    const next =
      direction > 0
        ? zoomSteps.find((step) => step > scale + 0.01)
        : [...zoomSteps].reverse().find((step) => step < scale - 0.01);
    if (next) changeZoom(next);
  };
  useEffect(() => {
    const element = scroller.current;
    if (!element || !zoomable) return;
    const onWheel = (event: WheelEvent) => {
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
  }, [zoomable]);
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
    const target = page ? element?.children[page - 1] : undefined;
    if (element && target)
      element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - 16;
  }, [scale]);

  // Page affichée : celle qui occupe le haut de la zone visible.
  const trackPage = () => {
    const element = scroller.current;
    if (!element || !pdf) return;
    const limit = element.getBoundingClientRect().top + element.clientHeight / 3;
    let page = 1;
    for (const [index, child] of [...element.children].entries())
      if (child.getBoundingClientRect().top <= limit) page = index + 1;
    setCurrent(page);
  };

  const position = pdf ? `Page ${current} / ${pdf.sizes.length}` : name;
  const ready = loaded.format !== "image" || natural !== undefined;
  return (
    <section className={classes} aria-label={label}>
      <Bar
        position={position}
        open={open}
        zoom={
          zoomable
            ? {
                percent: Math.round(scale * 100),
                canOut: ready && scale > zoomSteps[0] + 0.01,
                canIn: ready && scale < zoomSteps[zoomSteps.length - 1] - 0.01,
                fit: zoom === "fit",
                out: () => zoomBy(-1),
                in: () => zoomBy(1),
                toFit: () => changeZoom("fit"),
              }
            : undefined
        }
      />
      <div
        ref={scroller}
        className={`ui-document-viewer__body ui-document-viewer__body--${loaded.format}`}
        role="document"
        aria-label={pdf ? `${label}, ${pdf.sizes.length} page${pdf.sizes.length > 1 ? "s" : ""}` : label}
        onScroll={pdf ? trackPage : undefined}
      >
        {pdf
          ? pdf.sizes.map((size, index) => (
              <PdfPage
                // biome-ignore lint/suspicious/noArrayIndexKey: une page du PDF n’a pas d’autre identité que son numéro.
                key={index}
                document={pdf.document}
                number={index + 1}
                size={size}
                scale={scale}
                root={scroller}
              />
            ))
          : null}
        {loaded.format === "image" ? (
          <img
            className="ui-document-viewer__image"
            src={loaded.url}
            alt={label}
            decoding="async"
            style={natural ? { width: Math.round(natural.width * scale) } : { maxWidth: "100%" }}
            onLoad={(event) =>
              setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
            }
          />
        ) : null}
        {loaded.format === "text" ? <pre className="ui-document-viewer__text">{loaded.text}</pre> : null}
        {loaded.format === "markdown" ? (
          <div className="ui-document-viewer__markdown">
            <Markdown
              onLink={(href) => {
                if (/^(https?:|mailto:)/i.test(href)) services.openExternal(href);
              }}
            >
              {loaded.text}
            </Markdown>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Une page : sa place est réservée, elle n’est dessinée qu’à l’approche de la zone visible, puis à chaque zoom. */
function PdfPage({
  document,
  number,
  size,
  scale,
  root,
}: {
  document: PdfDocument;
  number: number;
  size: PdfPageSize;
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
    let current = true;
    const render = renderPdfPage(document, number, scale);
    // Le dessin précédent reste affiché jusqu’au nouveau : pas de clignotement pendant le zoom.
    render.promise.then(
      (canvas) => current && element.replaceChildren(canvas),
      () => undefined,
    );
    return () => {
      current = false;
      render.cancel();
    };
  }, [document, near, number, scale]);

  return (
    <div
      ref={holder}
      className="ui-document-viewer__page"
      role="img"
      aria-label={`Page ${number}`}
      style={{ width: Math.floor(size.width * scale), height: Math.floor(size.height * scale) }}
    />
  );
}
