import { imageDataUrl } from "../lib/chatImages";
import { ImagePreview } from "./ImagePreview";
import { LoadedImage } from "./LoadedImage";
import { useConversationResources } from "./resources";

function imageName(reference: string) {
  return reference.split(/[\\/]/).at(-1) || "Image";
}

/**
 * Images que l’agent a produites, consultées ou citées : montrées dans le fil, agrandissables, sans ouvrir le
 * détail des outils. Reprises de `ConversationImages` de OneApp.
 */
export function ConversationImages({ images, label }: { images: readonly string[]; label: string }) {
  const { loadImage, files } = useConversationResources();
  const shown = [...new Set(images)].filter((image) => imageDataUrl(image) || loadImage);
  if (!shown.length) return null;
  return (
    <section className="agent-chat__message-attachments" aria-label={label}>
      {shown.map((image, index) => {
        const inline = imageDataUrl(image);
        const alt = inline ? `${label} ${index + 1}` : imageName(image);
        return inline ? (
          <ImagePreview
            key={`${image.length}:${image.slice(-48)}`}
            src={inline}
            alt={alt}
            onSave={files ? () => files.save(image) : undefined}
          />
        ) : loadImage ? (
          <LoadedImage
            key={image}
            reference={image}
            alt={alt}
            load={loadImage}
            onSave={files ? () => files.save(image) : undefined}
          />
        ) : null;
      })}
    </section>
  );
}
