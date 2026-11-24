import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { useEffect, useState } from "react";
import { DocumentViewer, IconButton, Modal } from "socle-ui";
import { Row, Text } from "../../../kit";

/** Image montrée dans la vue agrandie : en ligne (`src`), ou fichier lu à la demande (`reference`). */
export interface ViewerImage {
  alt: string;
  src?: string;
  reference?: string;
}

/**
 * Vue agrandie des images de la conversation, la seule : une image, ou une suite d’images parcourue avec les flèches
 * (captures d’une même page). « Enregistrer une copie » quand `onSave` est fourni.
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
  const current = images[Math.min(Math.max(index, 0), images.length - 1)];
  const [loaded, setLoaded] = useState<{ reference: string; url?: string; failed?: boolean }>();
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
  const goLatest = useLatest(go);
  // Les flèches du clavier parcourent la suite tant que la vue est ouverte.
  useEffect(() => {
    if (!open || !several) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") goLatest(-1);
      else if (event.key === "ArrowRight") goLatest(1);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [goLatest, open, several]);
  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={label}
      size="xl"
      footer={
        several ? (
          <Row gap="xs">
            <IconButton icon={<ChevronLeft size={16} />} label="Image précédente" onPress={() => go(-1)} />
            <Text as="span" tone="muted" size="meta">
              {`${label} · ${index + 1} / ${images.length}`}
            </Text>
            <IconButton icon={<ChevronRight size={16} />} label="Image suivante" onPress={() => go(1)} />
          </Row>
        ) : undefined
      }
    >
      {src ? (
        // DocumentViewer de Socle (D-310) : zoom, et « Télécharger » pour enregistrer une copie.
        <DocumentViewer
          key={src}
          label={label}
          src={src}
          name={label}
          onDownload={onSave ? () => onSave(index) : undefined}
        />
      ) : (
        <Text tone="muted">{failed ? `Image indisponible : ${label}` : "Chargement de l’image…"}</Text>
      )}
    </Modal>
  );
}

/**
 * Vignette d’image, reprise de `ImagePreview` de OneApp : un clic l’agrandit, une image qui ne se charge pas se
 * réessaie d’un clic, et la vue agrandie propose « Enregistrer une copie ». Avec `gallery`, la vue agrandie parcourt
 * les images voisines (captures d’une même page).
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
  /** `sent` : image jointe à un message envoyé, en vignette carrée. */
  size?: "message" | "capture" | "sent";
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
      {/* La vignette est l’image elle-même : Socle n’a pas de bouton-image. */}
      <button
        type="button"
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
      </button>
      {expanded ? (
        <ImageViewer
          images={images}
          index={index}
          open={expanded}
          onIndex={setIndex}
          onClose={() => setExpanded(false)}
          onSave={onSave ? (shown) => onSave(gallery ? shown : undefined) : undefined}
          load={load}
        />
      ) : null}
    </span>
  );
}

/** Fonction stable qui appelle toujours la dernière version reçue. */
export function useLatest<T extends (...args: never[]) => unknown>(callback: T) {
  const [holder] = useState(() => ({ current: callback }));
  holder.current = callback;
  const [stable] = useState(() => ((...args: Parameters<T>) => holder.current(...args)) as T);
  return stable;
}
