import { IconButton, type IconButtonProps } from "@alfred/ui";
import { ArrowUp } from "lucide-react";

/**
 * Même pictogramme et même traitement pour l’envoi depuis la saisie ou la file, repris de `AgentSendButton` de
 * OneApp : rond, encre pleine ; `upRight` incline la flèche pour « Envoyer maintenant » d’un message en file.
 */
export function AgentSendButton({
  className,
  direction = "up",
  micro = false,
  ...props
}: Omit<IconButtonProps, "children" | "size"> & { direction?: "up" | "upRight"; micro?: boolean }) {
  return (
    <IconButton
      {...props}
      className={[
        "agent-send-button",
        micro && "agent-send-button--micro",
        direction === "upRight" && "agent-send-button--up-right",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <ArrowUp size={15} aria-hidden="true" />
    </IconButton>
  );
}
