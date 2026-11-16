import { Button, Dialog, IconButton } from "@alfred/ui";
import { Download, ImageOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Vignette d’image, reprise de `ImagePreview` de OneApp : un clic l’agrandit, une image qui ne se charge pas se
 * réessaie d’un clic, et la vue agrandie propose « Enregistrer une copie de l’image ».
 */
export function ImagePreview({
  src,
  alt,
  size = "message",
  onSave,
}: {
  src: string;
  alt: string;
  size?: "message" | "attachment";
  /** Enregistre une copie de l’image, proposée dans la vue agrandie. */
  onSave?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failedSource, setFailedSource] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const failed = failedSource === src;
  const label = alt || "Image";
  // La vue agrandie se ferme avec la vignette (conversation changée).
  useEffect(() => () => dialog.current?.close(), []);
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
            setExpanded(true);
            dialog.current?.showModal();
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
      {createPortal(
        <Dialog ref={dialog} className="image-preview__dialog" aria-label={label} onClose={() => setExpanded(false)}>
          <IconButton className="image-preview__close" label="Fermer l’image" onClick={() => dialog.current?.close()}>
            <X size={20} aria-hidden="true" />
          </IconButton>
          {onSave ? (
            <IconButton className="image-preview__save" label="Enregistrer une copie de l’image" onClick={onSave}>
              <Download size={20} aria-hidden="true" />
            </IconButton>
          ) : null}
          {expanded ? <img src={src} alt={label} referrerPolicy="no-referrer" /> : null}
        </Dialog>,
        document.body,
      )}
    </span>
  );
}
