import { useEffect, useState } from "react";
import { ImagePreview } from "./ImagePreview";

/** Image de l’espace de travail d’un agent, lue à la demande, reprise de `LoadedImage` de OneApp. */
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
  const [state, setState] = useState<{ reference: string; url?: string; failed?: boolean }>();
  useEffect(() => {
    let active = true;
    load(reference).then(
      (url) => active && setState({ reference, url }),
      () => active && setState({ reference, failed: true }),
    );
    return () => {
      active = false;
    };
  }, [load, reference]);
  if (state?.reference === reference && state.url)
    return <ImagePreview src={state.url} alt={alt || "Image"} onSave={onSave} />;
  return (
    <span className="markdown-text__image-status">
      {state?.reference === reference && state.failed
        ? `Image indisponible : ${alt || reference}`
        : "Chargement de l’image…"}
    </span>
  );
}
