import { useCallback, useEffect, useRef, useState } from "react";
import { type ImageSource, ImageThumbnail } from "socle-ui";
import { imageDataUrl } from "../lib/chatImages";

type Loaded = { url?: string; failed?: boolean };

/**
 * Images de l’espace de travail d’un agent, lues à la demande (reprises de `LoadedImage` de OneApp), prêtes pour
 * `ImageThumbnail` et `ImageGallery` de Socle : une image en ligne (`data:`) sert telle quelle ; une image citée par
 * son chemin est lue une fois, puis « Réessayer » la relit après un échec.
 */
export function useLoadedImages(wanted: readonly string[], load?: (reference: string) => Promise<string>) {
  const [entries, setEntries] = useState<Record<string, Loaded>>({});
  const started = useRef(new Set<string>());
  // Un autre dossier de travail (autre `load`) relit tout.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `load` change quand le dossier change.
  useEffect(() => {
    started.current = new Set();
    setEntries({});
  }, [load]);
  const fetch = useCallback(
    (reference: string) => {
      if (!load || imageDataUrl(reference) || started.current.has(reference)) return;
      started.current.add(reference);
      load(reference).then(
        (url) => setEntries((current) => ({ ...current, [reference]: { url } })),
        () => setEntries((current) => ({ ...current, [reference]: { failed: true } })),
      );
    },
    [load],
  );
  const key = wanted.join("\n");
  useEffect(() => {
    for (const reference of key ? key.split("\n") : []) fetch(reference);
  }, [key, fetch]);
  const retry = (reference: string) => {
    started.current.delete(reference);
    setEntries(({ [reference]: _dropped, ...rest }) => rest);
    fetch(reference);
  };
  /** Adresse et état d’une image pour Socle : en ligne, lue, en lecture ou en échec. */
  const source = (reference: string): Pick<ImageSource, "src" | "status" | "onRetry"> => {
    const inline = imageDataUrl(reference);
    if (inline) return { src: inline };
    const entry = entries[reference];
    if (entry?.url) return { src: entry.url };
    if (entry?.failed) return { status: "error", onRetry: () => retry(reference) };
    return { status: "loading" };
  };
  return { source, fetch };
}

/** Image citée dans le Markdown d’un message : lue à la demande, agrandie d’un clic. */
export function LoadedImage({
  reference,
  alt,
  load,
  onSave,
}: {
  reference: string;
  alt: string;
  load: (reference: string) => Promise<string>;
  onSave?: () => void;
}) {
  const { source } = useLoadedImages([reference], load);
  return <ImageThumbnail alt={alt || "Image"} {...source(reference)} onDownload={onSave} />;
}
