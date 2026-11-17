/** Formulaire d’un compte, ouvert depuis la fiche d’un module ou son parcours de configuration. */

import { AccountEditor } from "./AccountEditor";
import type { ClientInstanceItem, ClientItem } from "./api";

/** Compte à ajouter (sans `instance`) ou à modifier. */
export type ServiceEditing = { kind: "account"; client: ClientItem; instance?: ClientInstanceItem; help?: string };

export function ServiceEditor({
  editing,
  redirectUri,
  onDone,
}: {
  editing: ServiceEditing;
  redirectUri: string | null;
  onDone: () => void;
}) {
  return (
    <AccountEditor
      // Une clé par compte : le formulaire repart de zéro à chaque ouverture.
      key={`${editing.client.id}:${editing.instance?.id ?? "nouveau"}`}
      client={editing.client}
      initial={editing.instance}
      help={editing.help}
      redirectUri={redirectUri}
      onCancel={onDone}
      onSaved={onDone}
    />
  );
}
