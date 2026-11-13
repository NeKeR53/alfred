import { IconButton, PanelHeader } from "@alfred/ui";
import { X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { requestDialogClose } from "../ui/components/Dialog";

/**
 * En-tête des modales de la coquille, repris de `DialogHeader` de OneApp : titre, sous-titre facultatif et croix de
 * fermeture. La croix passe par le même chemin qu’Échap : une opération en cours qui refuse la fermeture la garde.
 */
export function DialogHeader({
  title,
  titleId,
  subtitle,
  dialogRef,
}: {
  title: ReactNode;
  titleId: string;
  subtitle?: ReactNode;
  dialogRef: RefObject<HTMLDialogElement | null>;
}) {
  return (
    <PanelHeader
      compact
      level={2}
      className="dialog-header"
      title={title}
      titleId={titleId}
      subtitle={subtitle}
      trailing={
        <IconButton label="Fermer" onClick={() => requestDialogClose(dialogRef.current)}>
          <X size={18} aria-hidden="true" />
        </IconButton>
      }
    />
  );
}
