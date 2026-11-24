import { useEffect, useState } from "react";
import { AttachmentChip, AttachmentList, Button } from "socle-ui";
import { imageFileType } from "../lib/chatImages";
import type { Attachment } from "../model";
import { ImagePreview } from "./ImagePreview";
import { useConversationResources } from "./resources";

function attachmentImageType(attachment: Attachment): string | undefined {
  if (attachment.mimeType?.startsWith("image/") && attachment.mimeType !== "image/svg+xml") return attachment.mimeType;
  return imageFileType(attachment.name) ?? imageFileType(attachment.path.split(/[\\/]/).at(-1) ?? "");
}

/**
 * Pièce jointe d’un message, reprise de `ChatAttachment` de OneApp : une image est lue depuis le disque, avec les
 * états « Chargement… » et « Image indisponible · Réessayer » ; un autre fichier s’affiche par son nom.
 */
function ChatAttachment({ attachment }: { attachment: Attachment }) {
  const { loadImage } = useConversationResources();
  const type = attachmentImageType(attachment);
  const [source, setSource] = useState<string>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!type || !loadImage) return;
    if (attempt > 0) setSource(undefined);
    let active = true;
    loadImage(attachment.path).then(
      (url) => active && setSource(url),
      () => active && setError(true),
    );
    return () => {
      active = false;
    };
  }, [attachment.path, attempt, loadImage, type]);
  if (error)
    return (
      <Button
        size="sm"
        onPress={() => {
          setError(false);
          setAttempt((value) => value + 1);
        }}
      >
        {`Image indisponible · Réessayer : ${attachment.name}`}
      </Button>
    );
  return source ? (
    <ImagePreview src={source} alt={attachment.name} size="sent" />
  ) : (
    <span role="status">Chargement de l’image : {attachment.name}…</span>
  );
}

/**
 * Pièces jointes d’un message envoyé : les images en vignettes agrandissables (Hors design : `AttachmentChip` ne
 * s’ouvre pas en grand), les autres fichiers en `AttachmentChip`.
 */
export function ChatAttachments({ attachments }: { attachments: readonly Attachment[] }) {
  const images = attachments.filter((attachment) => attachmentImageType(attachment));
  const files = attachments.filter((attachment) => !attachmentImageType(attachment));
  return (
    <>
      {images.length ? (
        <ul className="agent-chat__message-attachments">
          {images.map((attachment) => (
            <li key={attachment.path}>
              <ChatAttachment attachment={attachment} />
            </li>
          ))}
        </ul>
      ) : null}
      <AttachmentList>
        {files.map((attachment) => (
          <AttachmentChip key={attachment.path} kind="file" name={attachment.name} />
        ))}
      </AttachmentList>
    </>
  );
}
