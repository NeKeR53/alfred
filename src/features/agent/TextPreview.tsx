import { Button, Dialog, IconButton, PanelHeader } from "@alfred/ui";
import { FileText, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./text-preview.css";

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
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const summary = `${label} · ${text.length.toLocaleString("fr-FR")} caractères`;
  return (
    <span className="chat-text-preview">
      <Button
        className="chat-text-preview__chip"
        aria-label={`Voir ${summary}`}
        aria-haspopup="dialog"
        onClick={() => {
          setExpanded(true);
          dialog.current?.showModal();
        }}
      >
        <FileText size={15} aria-hidden="true" />
        <span>{summary}</span>
      </Button>
      {onRemove ? (
        <IconButton size="compact" label={`Retirer ${label}`} onClick={onRemove}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      ) : null}
      {createPortal(
        <Dialog
          ref={dialog}
          className="chat-text-preview__dialog"
          aria-labelledby={titleId}
          onClose={() => setExpanded(false)}
        >
          <PanelHeader
            compact
            level={2}
            title={summary}
            titleId={titleId}
            trailing={
              <IconButton label="Fermer le texte" onClick={() => dialog.current?.close()}>
                <X size={18} aria-hidden="true" />
              </IconButton>
            }
          />
          {expanded ? <textarea readOnly aria-label={`Contenu de ${label}`} value={text} /> : null}
        </Dialog>,
        document.body,
      )}
    </span>
  );
}
