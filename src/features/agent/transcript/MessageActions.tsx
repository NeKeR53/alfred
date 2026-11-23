import { CheckCheck, Copy, RotateCcw, Shuffle, TextQuote } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { IconButton } from "socle-ui";
import { notify } from "../../../shell/notifications";

export type Delivery = { startedAt: number; status: "sent" | "pending" | "error" | "cancelled" };

const dateTimeShort = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

export function formatDateTimeShort(value: number): string {
  return dateTimeShort.format(value);
}

export function deliveryLabel(status: Delivery["status"]): string {
  return status === "sent" ? "Envoyé" : status === "pending" ? "En cours" : status === "error" ? "Échec" : "Interrompu";
}

/**
 * Actions d’un message au survol, reprises de `MessageActions` de OneApp : statut de remise et horodatage, copie,
 * citation du passage sélectionné (sinon de tout le message), relance et « Repartir d’ici ».
 */
export function MessageActions({
  content,
  onResend,
  onFork,
  onQuote,
  delivery,
  timestamp,
  disabled,
  children,
}: {
  children: ReactNode;
  content: string;
  /** Renvoie le message à la suite du fil. */
  onResend?: () => void;
  /** Ouvre un nouvel agent qui repart de ce message. */
  onFork?: () => void;
  /** Cite le passage sélectionné du message, ou tout le message, dans la réponse en cours. */
  onQuote?: (text: string) => void;
  delivery?: Delivery;
  timestamp?: number;
  disabled?: boolean;
}) {
  const actions = useRef<HTMLFieldSetElement>(null);
  // La sélection est relevée avant que le clic ne déplace le focus.
  const selectedPassage = useRef("");
  const readSelection = () => {
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    const inside = node && actions.current?.closest(".agent-chat__entry")?.contains(node);
    selectedPassage.current = inside ? (selection?.toString().trim() ?? "") : "";
  };
  return (
    <>
      <div className="agent-chat__message-body">{children}</div>
      <fieldset
        ref={actions}
        className="agent-chat__message-actions"
        aria-label="Actions du message"
        // La sélection est relevée avant que l’appui ne déplace le focus.
        onPointerDownCapture={readSelection}
      >
        {delivery ? (
          <span className="agent-chat__message-delivery">
            {delivery.status === "sent" ? <CheckCheck size={12} aria-hidden="true" /> : null}
            <span>{deliveryLabel(delivery.status)}</span>
            <time dateTime={new Date(delivery.startedAt).toISOString()}>{formatDateTimeShort(delivery.startedAt)}</time>
            <span aria-hidden="true">·</span>
          </span>
        ) : timestamp !== undefined && Number.isFinite(new Date(timestamp).getTime()) ? (
          <span className="agent-chat__message-delivery">
            <time dateTime={new Date(timestamp).toISOString()}>{formatDateTimeShort(timestamp)}</time>
            <span aria-hidden="true">·</span>
          </span>
        ) : null}
        <IconButton
          icon={<Copy size={14} />}
          label="Copier le message"
          tooltipPlacement="top"
          onPress={() =>
            void navigator.clipboard.writeText(content).then(
              () => notify({ title: "Message copié", tone: "success" }),
              (error: unknown) =>
                notify({
                  title: "Message",
                  description: error instanceof Error ? error.message : "L’action a échoué.",
                  tone: "error",
                }),
            )
          }
        />
        {onQuote ? (
          <IconButton
            icon={<TextQuote size={14} />}
            label="Citer dans la réponse"
            tooltipPlacement="top"
            onPress={() => {
              if (!selectedPassage.current) readSelection();
              onQuote(selectedPassage.current || content);
              selectedPassage.current = "";
            }}
          />
        ) : null}
        {onResend ? (
          <IconButton
            icon={<RotateCcw size={14} />}
            label="Relancer le message"
            tooltipPlacement="top"
            isDisabled={disabled}
            onPress={onResend}
          />
        ) : null}
        {onFork ? (
          <IconButton
            icon={<Shuffle size={14} />}
            label="Repartir d’ici"
            tooltipPlacement="top"
            isDisabled={disabled}
            onPress={onFork}
          />
        ) : null}
      </fieldset>
    </>
  );
}
