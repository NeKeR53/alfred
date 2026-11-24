import { useMemo } from "react";
import { ImageGallery } from "socle-ui";
import { captureCaption, captureGroups, type PageCapture, SHOWN_CAPTURES_PER_PAGE } from "../lib/pageCaptures";
import { useLoadedImages } from "./LoadedImage";
import { useConversationResources } from "./resources";

/**
 * Captures d’écran prises par l’agent pendant un tour : une `ImageGallery` de Socle sous son travail, visible même
 * quand les outils sont repliés, groupée par page. Les trois plus récentes de chaque page sont lues tout de suite ; une
 * capture plus ancienne est lue quand la vue agrandie l’atteint.
 */
export function PageCaptures({ captures }: { captures: readonly PageCapture[] }) {
  const { loadImage, files } = useConversationResources();
  const groups = useMemo(() => captureGroups(captures), [captures]);
  const byId = useMemo(() => new Map(captures.map((capture) => [capture.id, capture])), [captures]);
  const { source, fetch } = useLoadedImages(
    groups.flatMap((group) => group.shown.map((capture) => capture.image)),
    loadImage,
  );
  if (!groups.length) return null;
  return (
    <ImageGallery
      label="Captures de l’agent"
      shape="page"
      visible={SHOWN_CAPTURES_PER_PAGE}
      groups={groups.map((group) => ({
        id: group.page,
        label: group.captures[0]?.title ?? group.page,
        images: group.captures.map((capture) => ({
          id: capture.id,
          alt: captureCaption(capture),
          caption: captureCaption(capture),
          ...source(capture.image),
        })),
      }))}
      onView={(image) => {
        const capture = byId.get(image.id);
        if (capture) fetch(capture.image);
      }}
      onDownload={
        files
          ? (image) => {
              const capture = byId.get(image.id);
              if (capture) files.save(capture.image);
            }
          : undefined
      }
    />
  );
}
