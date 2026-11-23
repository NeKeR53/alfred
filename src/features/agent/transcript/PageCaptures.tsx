import { useEffect, useMemo, useState } from "react";
import { Button } from "socle-ui";
import { imageDataUrl } from "../lib/chatImages";
import { type CaptureGroup, captureCaption, captureGroups, type PageCapture } from "../lib/pageCaptures";
import { ImagePreview, ImageViewer, type ViewerImage } from "./ImagePreview";
import { useConversationResources } from "./resources";

const viewerImage = (capture: PageCapture): ViewerImage => {
  const inline = imageDataUrl(capture.image);
  return inline
    ? { alt: captureCaption(capture), src: inline }
    : { alt: captureCaption(capture), reference: capture.image };
};

/** Vignette d’une capture : le fichier gardé par Alfred, lu à la demande, agrandi d’un clic. */
function CaptureThumbnail({
  capture,
  group,
  gallery,
  index,
}: {
  capture: PageCapture;
  group: CaptureGroup;
  gallery: readonly ViewerImage[];
  index: number;
}) {
  const { loadImage, files } = useConversationResources();
  const inline = imageDataUrl(capture.image);
  const [loaded, setLoaded] = useState<{ image: string; url?: string; failed?: boolean }>();
  useEffect(() => {
    if (inline || !loadImage) return;
    let active = true;
    loadImage(capture.image).then(
      (url) => active && setLoaded({ image: capture.image, url }),
      () => active && setLoaded({ image: capture.image, failed: true }),
    );
    return () => {
      active = false;
    };
  }, [capture.image, inline, loadImage]);
  const src = inline ?? (loaded?.image === capture.image ? loaded.url : undefined);
  const caption = captureCaption(capture);
  // La vignette déjà lue sert à la vue agrandie : pas de second chargement au clic.
  const shownGallery = useMemo(
    () => gallery.map((image, position) => (position === index && src ? { ...image, src } : image)),
    [gallery, index, src],
  );
  return (
    <figure className="page-captures__item">
      {src ? (
        <ImagePreview
          src={src}
          alt={caption}
          size="capture"
          gallery={{ images: shownGallery, index }}
          load={loadImage}
          onSave={files ? (shown) => files.save(group.captures[shown ?? index]?.image ?? capture.image) : undefined}
        />
      ) : (
        <span className="page-captures__placeholder">
          {loaded?.image === capture.image && loaded.failed ? "Capture indisponible" : "Chargement…"}
        </span>
      )}
      <figcaption className="page-captures__caption" title={caption}>
        {caption}
      </figcaption>
    </figure>
  );
}

/** « + N » : les captures plus anciennes de la page, ouvertes dans la vue agrandie. */
function HiddenCaptures({ group, gallery }: { group: CaptureGroup; gallery: readonly ViewerImage[] }) {
  const { loadImage, files } = useConversationResources();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const count = group.hidden.length;
  const title = group.captures[0]?.title ?? group.page;
  return (
    <>
      <Button
        size="sm"
        aria-label={`+ ${count} : voir ${count} autre${count > 1 ? "s" : ""} capture${count > 1 ? "s" : ""} de ${title}`}
        onPress={() => {
          setIndex(count - 1);
          setOpen(true);
        }}
      >
        {`+ ${count}`}
      </Button>
      {open ? (
        <ImageViewer
          images={gallery}
          index={index}
          open={open}
          onIndex={setIndex}
          onClose={() => setOpen(false)}
          load={loadImage}
          onSave={files ? (shown) => files.save(group.captures[shown]?.image ?? "") : undefined}
        />
      ) : null}
    </>
  );
}

/**
 * Captures d’écran prises par l’agent pendant un tour, en une rangée de petites vignettes sous son travail, visibles
 * même quand les outils sont repliés. Au plus trois par page, les plus récentes ; les autres derrière « + N ».
 */
export function PageCaptures({ captures }: { captures: readonly PageCapture[] }) {
  const groups = useMemo(() => captureGroups(captures), [captures]);
  if (!groups.length) return null;
  return (
    <section className="page-captures" aria-label="Captures de l’agent">
      {groups.map((group) => {
        const gallery = group.captures.map(viewerImage);
        return (
          <div key={group.page} className="page-captures__group">
            {group.hidden.length ? <HiddenCaptures group={group} gallery={gallery} /> : null}
            {group.shown.map((capture) => (
              <CaptureThumbnail
                key={capture.id}
                capture={capture}
                group={group}
                gallery={gallery}
                index={group.captures.indexOf(capture)}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
}
