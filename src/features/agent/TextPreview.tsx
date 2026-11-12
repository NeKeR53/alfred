import { Button, Dialog, IconButton, PanelHeader } from "@alfred/ui";
import { FileText, X } from "lucide-react";
import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import "./text-preview.css";

/** Bloc de contexte replié (collage long) : une pastille qui ouvre le texte complet en lecture seule. */
export function TextPreview({ text, label, onRemove }: { text: string; label: string; onRemove?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const summary = `${label} · ${text.length.toLocaleString("fr-FR")} caractères`;
  return (
    <span className="chat-text-preview">
      <Button
        className="chat-text-preview__chip"
        aria-label={`Voir ${summary}`}
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
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
        <Dialog ref={dialog} className="chat-text-preview__dialog" aria-labelledby={titleId}>
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
          <textarea readOnly aria-label={`Contenu de ${label}`} value={text} />
        </Dialog>,
        document.body,
      )}
    </span>
  );
}
