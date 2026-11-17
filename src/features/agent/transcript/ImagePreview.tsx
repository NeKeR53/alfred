import { Button, Dialog, IconButton } from "@alfred/ui";
import { ChevronLeft, ChevronRight, Download, ImageOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Image montrée dans la vue agrandie : en ligne (`src`), ou fichier lu à la demande (`reference`). */
export interface ViewerImage {
  alt: string;
  src?: string;
  reference?: string;
}

/**
 * Vue agrandie des images de la conversation, la seule : une image, ou une suite d’images parcourue avec les flèches
 * (captures d’une même page). « Enregistrer une copie de l’image » quand `onSave` est fourni.
 */
export function ImageViewer({
  images,
  index,
  open,
  onIndex,
  onClose,
  onSave,
  load,
}: {
  images: readonly ViewerImage[];
  index: number;
  open: boolean;
  onIndex?: (index: number) => void;
  onClose: () => void;
  onSave?: (index: number) => void;
  /** Lit une image citée par son chemin. */
  load?: (reference: string) => Promise<string>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const current = images[Math.min(Math.max(index, 0), images.length - 1)];
  const [loaded, setLoaded] = useState<{ reference: string; url?: string; failed?: boolean }>();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  // La vue agrandie se ferme avec la vignette (conversation changée).
  useEffect(() => () => dialog.current?.close(), []);
  const reference = open && !current?.src ? current?.reference : undefined;
  useEffect(() => {
    if (!reference || !load) return;
    let active = true;
    load(reference).then(
      (url) => active && setLoaded({ reference, url }),
      () => active && setLoaded({ reference, failed: true }),
    );
    return () => {
      active = false;
    };
  }, [load, reference]);
  const src = current?.src ?? (loaded?.reference === current?.reference ? loaded?.url : undefined);
  const failed = !current?.src && loaded?.reference === current?.reference && loaded?.failed;
  const label = current?.alt || "Image";
  const several = images.length > 1;
  const go = (step: number) => {
    if (!several || !onIndex) return;
    onIndex((index + step + images.length) % images.length);
  };
  return createPortal(
    <Dialog
      ref={dialog}
      className="image-preview__dialog"
      aria-label={label}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") go(-1);
        else if (event.key === "ArrowRight") go(1);
      }}
    >
      <IconButton className="image-preview__close" label="Fermer l’image" onClick={() => dialog.current?.close()}>
        <X size={20} aria-hidden="true" />
      </IconButton>
      {onSave ? (
        <IconButton
          className="image-preview__save"
          label="Enregistrer une copie de l’image"
          onClick={() => onSave(index)}
        >
          <Download size={20} aria-hidden="true" />
        </IconButton>
      ) : null}
      {open && src ? (
        <img src={src} alt={label} referrerPolicy="no-referrer" />
      ) : open ? (
        <p className="image-preview__status">{failed ? `Image indisponible : ${label}` : "Chargement de l’image…"}</p>
      ) : null}
      {several ? (
        <>
          <IconButton className="image-preview__previous" label="Image précédente" onClick={() => go(-1)}>
            <ChevronLeft size={20} aria-hidden="true" />
          </IconButton>
          <IconButton className="image-preview__next" label="Image suivante" onClick={() => go(1)}>
            <ChevronRight size={20} aria-hidden="true" />
          </IconButton>
          <p className="image-preview__caption">
            {label} · {index + 1} / {images.length}
          </p>
        </>
      ) : null}
    </Dialog>,
    document.body,
  );
}

/**
 * Vignette d’image, reprise de `ImagePreview` de OneApp : un clic l’agrandit, une image qui ne se charge pas se
 * réessaie d’un clic, et la vue agrandie propose « Enregistrer une copie de l’image ». Avec `gallery`, la vue
 * agrandie parcourt les images voisines (captures d’une même page).
 */
export function ImagePreview({
  src,
  alt,
  size = "message",
  onSave,
  gallery,
  load,
}: {
  src: string;
  alt: string;
  size?: "message" | "attachment" | "capture";
  /** Enregistre une copie de l’image, proposée dans la vue agrandie. */
  onSave?: (index?: number) => void;
  gallery?: { images: readonly ViewerImage[]; index: number };
  load?: (reference: string) => Promise<string>;
}) {
  const [failedSource, setFailedSource] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [index, setIndex] = useState(0);
  const failed = failedSource === src;
  const label = alt || "Image";
  const images = gallery?.images ?? [{ src, alt: label }];
  return (
    <span className={`image-preview image-preview--${size}`}>
      <Button
        className="image-preview__thumbnail"
        aria-label={failed ? `Réessayer l’image : ${label}` : `Agrandir l’image : ${label}`}
        onClick={() => {
          if (failed) {
            setFailedSource(undefined);
            setAttempt((value) => value + 1);
          } else {
            setIndex(gallery?.index ?? 0);
            setExpanded(true);
          }
        }}
      >
        {failed ? (
          <span className="image-preview__error">
            <ImageOff size={20} aria-hidden="true" />
            <span>Image indisponible</span>
          </span>
        ) : (
          <img
            key={`${src}:${attempt}`}
            src={src}
            alt={label}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailedSource(src)}
          />
        )}
      </Button>
      <ImageViewer
        images={images}
        index={index}
        open={expanded}
        onIndex={setIndex}
        onClose={() => setExpanded(false)}
        onSave={onSave ? (shown) => onSave(gallery ? shown : undefined) : undefined}
        load={load}
      />
    </span>
  );
}
