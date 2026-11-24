import { AttachmentChip, AttachmentList, ImageGallery } from "socle-ui";
import { imageFileType } from "../lib/chatImages";
import type { Attachment } from "../model";
import { useLoadedImages } from "./LoadedImage";
import { useConversationResources } from "./resources";

function attachmentImageType(attachment: Attachment): string | undefined {
  if (attachment.mimeType?.startsWith("image/") && attachment.mimeType !== "image/svg+xml") return attachment.mimeType;
  return imageFileType(attachment.name) ?? imageFileType(attachment.path.split(/[\\/]/).at(-1) ?? "");
}

/**
 * Pièces jointes d’un message envoyé, reprises de `ChatAttachment` de OneApp : les images lues depuis le disque, en
 * vignettes carrées d’une `ImageGallery` (agrandies d’un clic, « Réessayer » après un échec), les autres fichiers en
 * `AttachmentChip`.
 */
export function ChatAttachments({ attachments }: { attachments: readonly Attachment[] }) {
  const { loadImage } = useConversationResources();
  const images = attachments.filter((attachment) => attachmentImageType(attachment));
  const files = attachments.filter((attachment) => !attachmentImageType(attachment));
  const { source } = useLoadedImages(
    images.map((image) => image.path),
    loadImage,
  );
  return (
    <>
      {images.length ? (
        <ImageGallery
          label="Images jointes"
          shape="square"
          images={images.map((image) => ({ id: image.path, alt: image.name, ...source(image.path) }))}
        />
      ) : null}
      <AttachmentList>
        {files.map((attachment) => (
          <AttachmentChip key={attachment.path} kind="file" name={attachment.name} />
        ))}
      </AttachmentList>
    </>
  );
}
