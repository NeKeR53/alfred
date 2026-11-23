import { FileText, X } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, IconButton, TextArea } from "socle-ui";

/**
 * Texte replié (collage long, long message envoyé) : une carte « {libellé} · N caractères » qui ouvre le texte complet
 * en lecture seule, reprise de `TextPreview` de OneApp. Le texte n’est mis dans la boîte qu’à son ouverture.
 */
export function TextPreview({
  text,
  label = "Texte",
  onRemove,
}: {
  text: string;
  label?: string;
  onRemove?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = `${label} · ${text.length.toLocaleString("fr-FR")} caractères`;
  return (
    <span className="chat-text-preview">
      <Button
        size="sm"
        variant="subtle"
        icon={<FileText size={15} />}
        aria-label={`Voir ${summary}`}
        onPress={() => setExpanded(true)}
      >
        {summary}
      </Button>
      {onRemove ? <IconButton icon={<X size={14} />} label={`Retirer ${label}`} onPress={onRemove} /> : null}
      {expanded ? (
        <Dialog isOpen onOpenChange={setExpanded} title={summary} size="lg">
          <TextArea label={`Contenu de ${label}`} hideLabel isReadOnly value={text} minRows={8} maxRows={24} />
        </Dialog>
      ) : null}
    </span>
  );
}
