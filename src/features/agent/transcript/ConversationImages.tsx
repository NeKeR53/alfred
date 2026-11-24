import { ImageGallery } from "socle-ui";
import { imageDataUrl } from "../lib/chatImages";
import { useLoadedImages } from "./LoadedImage";
import { useConversationResources } from "./resources";

function imageName(reference: string) {
  return reference.split(/[\\/]/).at(-1) || "Image";
}

/**
 * Images que l’agent a produites, consultées ou citées : une `ImageGallery` de Socle dans le fil, agrandissable,
 * parcourue aux flèches, sans ouvrir le détail des outils. Reprises de `ConversationImages` de OneApp.
 */
export function ConversationImages({ images, label }: { images: readonly string[]; label: string }) {
  const { loadImage, files } = useConversationResources();
  const shown = [...new Set(images)].filter((image) => imageDataUrl(image) || loadImage);
  const { source } = useLoadedImages(shown, loadImage);
  if (!shown.length) return null;
  // Identifiant stable d’une image : son chemin, ou la fin de son adresse en ligne.
  const ids = new Map(
    shown.map((image, index) => [imageDataUrl(image) ? `${index}:${image.length}:${image.slice(-48)}` : image, image]),
  );
  return (
    <ImageGallery
      label={label}
      shape="wide"
      images={[...ids].map(([id, image], index) => ({
        id,
        alt: imageDataUrl(image) ? `${label} ${index + 1}` : imageName(image),
        ...source(image),
      }))}
      onDownload={files ? (image) => files.save(ids.get(image.id) ?? image.id) : undefined}
    />
  );
}
