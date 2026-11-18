/** Formulaire d’un compte, ouvert depuis la fiche d’un module ou son parcours de configuration. */

import { useState } from "react";
import { useShell } from "../../shell/store";
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
  // Un compte tout juste ajouté reste ouvert, pour lui ajouter des pages, quand le module en a pour ses comptes.
  const [created, setCreated] = useState<{ client: ClientItem; instance: ClientInstanceItem }>();
  const hasAccountPages = useShell((state) =>
    Boolean(state.snapshot?.accountPages?.some((page) => page.client === editing.client.id)),
  );
  const client = created?.client ?? editing.client;
  const instance = created?.instance ?? editing.instance;
  return (
    <AccountEditor
      // Une clé par compte : le formulaire repart de zéro à chaque ouverture.
      key={`${client.id}:${instance?.id ?? "nouveau"}`}
      client={client}
      initial={instance}
      help={editing.help}
      redirectUri={redirectUri}
      created={Boolean(created)}
      onCancel={onDone}
      onSaved={({ saved, instance: id, created: isNew }) => {
        const added = saved.instances.find((candidate) => candidate.id === id);
        if (isNew && added && hasAccountPages) setCreated({ client: saved, instance: added });
        else onDone();
      }}
    />
  );
}
