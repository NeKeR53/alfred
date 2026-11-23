import { ArrowUp, ArrowUpRight } from "lucide-react";
import { IconButton } from "socle-ui";

/**
 * Même pictogramme pour l’envoi depuis la saisie ou la file, repris de `AgentSendButton` de OneApp ; `upRight` incline
 * la flèche pour « Envoyer maintenant » d’un message en file.
 */
export function AgentSendButton({
  label,
  direction = "up",
  isDisabled,
  isPending,
  onPress,
}: {
  label: string;
  direction?: "up" | "upRight";
  isDisabled?: boolean;
  isPending?: boolean;
  onPress: () => void;
}) {
  return (
    <IconButton
      icon={direction === "upRight" ? <ArrowUpRight size={15} /> : <ArrowUp size={15} />}
      label={label}
      tooltipPlacement="top"
      isDisabled={isDisabled}
      isPending={isPending}
      onPress={onPress}
    />
  );
}
