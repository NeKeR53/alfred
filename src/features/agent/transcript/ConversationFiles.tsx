import { Paperclip } from "lucide-react";
import { Button, Disclosure } from "socle-ui";
import { conversationFileName, conversationFilePath, isPdfDocument } from "../lib/conversationFileKinds";
import { PdfPreview } from "./PdfPreview";
import { useConversationResources } from "./resources";

/**
 * Fichier d’une conversation, repris de `ConversationFile` de OneApp : son nom, et, pour un fichier produit par
 * l’agent, l’ouverture avec l’application du système, l’enregistrement d’une copie et l’aperçu d’un PDF.
 */
export function ConversationFile({
  reference,
  name,
  actions = true,
}: {
  reference: string;
  name?: string;
  actions?: boolean;
}) {
  const { files } = useConversationResources();
  const label = name ?? conversationFileName(reference);
  const folder = conversationFilePath(reference).split(/[\\/]/).slice(0, -1).join("/");
  const available = actions ? files : undefined;
  return (
    <div className="agent-chat__file">
      <span className="agent-chat__attachment-file" title={reference}>
        <Paperclip size={14} aria-hidden="true" />
        <span>{label}</span>
        {folder && available ? <small>{folder}</small> : null}
      </span>
      {available ? (
        <span className="agent-chat__file-actions">
          <Button size="sm" aria-label={`Ouvrir ${label}`} onPress={() => available.open(reference)}>
            Ouvrir
          </Button>
          <Button size="sm" aria-label={`Enregistrer… une copie de ${label}`} onPress={() => available.save(reference)}>
            Enregistrer…
          </Button>
        </span>
      ) : null}
      {available && isPdfDocument(reference) ? (
        <Disclosure title="Aperçu">
          <PdfPreview label={`Aperçu de ${label}`} source={reference} generate={() => available.read(reference)} />
        </Disclosure>
      ) : null}
    </div>
  );
}

/** Documents produits ou cités par l’agent, montrés sous le message ou sous le tour. */
export function ConversationFiles({ files, label }: { files: readonly string[]; label: string }) {
  const shown = [...new Set(files)];
  if (!shown.length) return null;
  return (
    <section className="agent-chat__files" aria-label={label}>
      {shown.map((reference) => (
        <ConversationFile key={reference} reference={reference} />
      ))}
    </section>
  );
}
